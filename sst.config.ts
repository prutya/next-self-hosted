/// <reference path="./.sst/platform/config.d.ts" />
import { resolve as pathResolve } from "node:path";
import { writeFileSync as fsWriteFileSync } from "node:fs";
import { asset as pulumiAsset, all as pulumiAll } from "@pulumi/pulumi";
// Specity HCLOUD_TOKEN and CLOUDFLARE_API_TOKEN before running
// Permissions for CLOUDFLARE_API_TOKEN:
// - Account / Cloudflare Tunnel : Edit
// - Account / Account Settings : Read
// - Zone / Zone Settings : Edit
// - Zone / DNS : Edit
const CLOUDFLARE_ACCOUNT_ID = "34193a17c0be47ddc2eeac256a159e12";
const CLOUDFLARE_ZONE_ID = "d0d8f8f31e583bfcd9885aa7dfff9b89";
const DOMAIN_NAME = "next-self-hosted.click";
export default $config({
  app(input) {
    return {
      name: "next-self-hosted",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "local",
      providers: {
        hcloud: true,
        tls: true,
        docker: true,
        "@pulumi/command": true,
        cloudflare: true,
        random: true,
      },
    };
  },
  async run() {
    // Generate an SSH key
    const sshKeyLocal = new tls.PrivateKey("SSH Key - Local", {
      algorithm: "ED25519",
    });
    // Add the SSH key to Hetzner
    const sshKeyHetzner = new hcloud.SshKey("SSH Key - Hetzner", {
      publicKey: sshKeyLocal.publicKeyOpenssh,
    });
    // Create a Firewall on Hetzner
    const firewall = new hcloud.Firewall("Firewall", {
      rules: [
        {
          port: "22",
          protocol: "tcp",
          direction: "in",
          sourceIps: ["0.0.0.0/0", "::/0"],
        },
      ],
    });
    // Create a Server on Hetzner
    const server = new hcloud.Server("Server", {
      image: "docker-ce",
      serverType: "cx22",
      location: "nbg1",
      sshKeys: [sshKeyHetzner.id],
    });
    // Attach Firewall to Server
    const firewallAttachment = new hcloud.FirewallAttachment(
      "Firewall Attachment - Server - Firewall",
      {
        firewallId: firewall.id.apply((id) => parseInt(id)),
        serverIds: [server.id.apply((id) => parseInt(id))],
      }
    );
    // Store the private SSH Key on disk to be able to pass it to the Docker
    // Provider
    const sshKeyLocalPath = sshKeyLocal.privateKeyOpenssh.apply((k) => {
      const path = "id_ed25519_hetzner";
      fsWriteFileSync(path, k, { mode: 0o600 });
      return pathResolve(path);
    });
    // Reuse SSH connection settings
    const serverSSHConnection = pulumiAll([sshKeyLocal, server]).apply(
      ([key, server]) => {
        return {
          host: server.ipv4Address,
          user: "root",
          privateKey: key.privateKeyOpenssh,
        };
      }
    );
    // Ensure Docker running
    const commandEnsureDockerRunning = new command.remote.Command(
      "Command - Ensure Docker running",
      {
        create: "nc -U -z /var/run/docker.sock",
        connection: serverSSHConnection,
      }
    );
    // Connect to the Docker Server on the Hetzner Server
    const dockerServerHetzner = new docker.Provider(
      "Docker Server - Hetzner",
      {
        host: $interpolate`ssh://root@${server.ipv4Address}`,
        sshOpts: ["-i", sshKeyLocalPath, "-o", "StrictHostKeyChecking=no"],
      },
      { dependsOn: [commandEnsureDockerRunning] }
    );
    // Build the Docker image
    const dockerImageHetzner = new docker.Image(
      "Docker Image - App - Hetzner",
      {
        imageName: "next-self-hosted/next-self-hosted:latest",
        build: {
          context: pathResolve("./"),
          dockerfile: pathResolve("./Dockerfile"),
          target: "production",
          platform: "linux/amd64",
        },
        skipPush: true,
      },
      {
        provider: dockerServerHetzner,
        dependsOn: [commandEnsureDockerRunning],
      }
    );
    // Setup Docker Volumes
    const dockerVolumeAppBuild = new docker.Volume(
      "Docker Volume - App Build",
      { name: "app_volume_build" },
      { provider: dockerServerHetzner, dependsOn: [server] }
    );
    // Setup Docker Networks
    const dockerNetworkPublic = new docker.Network(
      "Docker Network - Public",
      { name: "app_network_public" },
      { provider: dockerServerHetzner, dependsOn: [server] }
    );
    const dockerNetworkInternal = new docker.Network(
      "Docker Network - Internal",
      { name: "app_network_internal" },
      { provider: dockerServerHetzner, dependsOn: [server] }
    );
    // Run a one-off container to build the app
    const dockerAppBuildContainer = new docker.Container(
      "Docker Container - App Build",
      {
        name: "app_container_build",
        image: dockerImageHetzner.imageName,
        volumes: [
          {
            volumeName: dockerVolumeAppBuild.name,
            containerPath: "/app/.next",
          },
        ],
        command: ["pnpm", "build"],
        mustRun: true,
      },
      {
        provider: dockerServerHetzner,
      }
    );
    // Run the app container
    const dockerAppContainer = new docker.Container(
      "Docker Container - App",
      {
        name: "app",
        image: dockerImageHetzner.imageName,
        volumes: [
          {
            volumeName: dockerVolumeAppBuild.name,
            containerPath: "/app/.next",
          },
        ],
        networksAdvanced: [
          { name: dockerNetworkPublic.id },
          { name: dockerNetworkInternal.id },
        ],
        command: ["pnpm", "start"],
        restart: "always",
      },
      { provider: dockerServerHetzner, dependsOn: [dockerAppBuildContainer] }
    );
    // Ensure app directory exists
    new command.remote.Command("Command - Ensure app directory", {
      create: "mkdir -p /root/app",
      connection: serverSSHConnection,
    });
    // Copy Nginx config to the VPS
    const commandCopyNginxConfig = new command.remote.CopyToRemote(
      "Copy - Nginx Config",
      {
        source: new pulumiAsset.FileAsset(
          pathResolve("./nginx/production.conf")
        ),
        remotePath: "/root/app/nginx.conf",
        connection: serverSSHConnection,
      }
    );
    // Run the Nginx container
    const dockerNginxContainer = new docker.Container(
      "Docker Container - Nginx",
      {
        name: "app_container_nginx",
        image: "nginx:1.27.0-bookworm",
        volumes: [
          {
            hostPath: "/root/app/nginx.conf",
            containerPath: "/etc/nginx/nginx.conf",
          },
        ],
        command: ["nginx", "-g", "daemon off;"],
        networksAdvanced: [{ name: dockerNetworkPublic.id }],
        restart: "always",
        healthcheck: {
          tests: ["CMD", "service", "nginx", "status"],
          interval: "30s",
          timeout: "5s",
          retries: 5,
          startPeriod: "10s",
        },
      },
      {
        provider: dockerServerHetzner,
        dependsOn: [dockerAppContainer],
      }
    );
    // Create Cloudflare Provider
    const cloudflareProvider = new cloudflare.Provider("Cloudflare", {
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
    });
    // Set Full(Strict) TLS on Cloudflare
    // Enable "Always Use HTTPS" on Cloudflare
    // Enable TLS 1.3 on Cloudflare
    // Set Minimum TLS version to 1.2 on Cloudflare
    new cloudflare.ZoneSettingsOverride(
      "Cloudflare Zone Settings Override",
      {
        zoneId: CLOUDFLARE_ZONE_ID,
        settings: {
          alwaysUseHttps: "on",
          tls13: "on",
          minTlsVersion: "1.2",
        },
      },
      { provider: cloudflareProvider }
    );
    // Create a secret for Cloudflare Tunnel
    const cloudflareTunnelSecret = new random.RandomBytes(
      "Random - Cloudflare Tunnel secret",
      { length: 32 }
    ).base64;
    // Create Cloudflare Tunnel
    const cloudflareTunnel = new cloudflare.Tunnel("Cloudflare - Tunnel", {
      accountId: CLOUDFLARE_ACCOUNT_ID,
      name: DOMAIN_NAME,
      secret: cloudflareTunnelSecret,
      configSrc: "cloudflare",
    });
    // Configure the tunnel to route the traffic to the NGINX container
    const cloudflareTunnelConfig = new cloudflare.TunnelConfig(
      "Cloudflare - Tunnel Config",
      {
        accountId: CLOUDFLARE_ACCOUNT_ID,
        tunnelId: cloudflareTunnel.id,
        config: {
          ingressRules: [{ service: "http://app_container_nginx:80" }],
        },
      }
    );
    // Spin up cloudflared on the VPS
    const dockerCloudflaredContainer = new docker.Container(
      "Docker Container - Cloudflared",
      {
        name: "app_container_cloudflared",
        image: "cloudflare/cloudflared:2024.8.2",
        command: ["tunnel", "--no-autoupdate", "run"],
        envs: [$interpolate`TUNNEL_TOKEN=${cloudflareTunnel.tunnelToken}`],
        networksAdvanced: [{ name: dockerNetworkPublic.id }],
        restart: "always",
      },
      { provider: dockerServerHetzner }
    );
    // Make sure Cloudflare DNS it pointing to the correct CNAME
    new cloudflare.Record(
      "Cloudflare DNS Record - Server",
      {
        name: "@",
        zoneId: CLOUDFLARE_ZONE_ID,
        type: "CNAME",
        content: cloudflareTunnel.cname,
        proxied: true,
      },
      { provider: cloudflareProvider }
    );
    return {
      cloudflareTunnelSecret,
    };
  },
});

/// <reference path="./.sst/platform/config.d.ts" />

import { resolve as pathResolve } from "node:path";
import { writeFileSync as fsWriteFileSync } from "node:fs";
import { asset as pulumiAsset, all as pulumiAll } from "@pulumi/pulumi";

// Specity HCLOUD_TOKEN and CLOUDFLARE_API_TOKEN before running
// Permissions for CLOUDFLARE_API_TOKEN:
// - Account Settings:Read
// - Zone Settings:Edit
// - SSL and Certificates:Edit
// - DNS:Edit

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
        {
          port: "443",
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

    // Ensure app/certs directory exists
    new command.remote.Command("Command - Ensure app/certs directory", {
      create: "mkdir -p /root/app/certs",
      connection: {
        host: server.ipv4Address,
        user: "root",
        privateKey: sshKeyLocal.privateKeyOpenssh,
      },
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

    // Create Cloudflare Provider
    const cloudflareProvider = new cloudflare.Provider("Cloudflare", {
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
    });

    // Create Private Key for Cloudflare Origin Server certificate
    const originServerCertKey = new tls.PrivateKey(
      "TLS Key - Cloudflare Origin Server",
      {
        algorithm: "ECDSA",
        ecdsaCurve: "P256",
      }
    );

    // Create Certificate Signing Request for Cloudflare Origin Server certificate
    const csr = new tls.CertRequest("CSR - Cloudflare Origin Server", {
      privateKeyPem: originServerCertKey.privateKeyPem,
      subject: {
        commonName: "",
        organization: "Next Self Hosted App",
      },
    });

    // Generate Cloudflare certificates
    const cert = new cloudflare.OriginCaCertificate(
      "Certificate - Cloudflare Origin Server",
      {
        csr: csr.certRequestPem,
        hostnames: [`*.${DOMAIN_NAME}`, DOMAIN_NAME],
        requestType: "origin-ecc",
        requestedValidity: 5475,
      },
      { provider: cloudflareProvider }
    );

    // Copy Cloudflare Origin Server private key to the VPS
    const commandCopyCertificatePrivate = new command.remote.CopyToRemote(
      "Copy - Certificates - Key",
      {
        source: originServerCertKey.privateKeyPem.apply((k) => {
          const path = "./certs/cloudflare.key.pem";
          fsWriteFileSync(path, k);
          return new pulumiAsset.FileAsset(pathResolve(path));
        }),
        remotePath: "/root/app/certs/cloudflare.key.pem",
        connection: serverSSHConnection,
      },
      {
        dependsOn: [cert],
      }
    );

    // Copy Cloudflare Origin Server certificate to the VPS
    const commandCopyCertificateCert = new command.remote.CopyToRemote(
      "Copy - Certificates - Cert",
      {
        source: cert.certificate.apply((k) => {
          const path = "./certs/cloudflare.cert.pem";
          fsWriteFileSync(path, k);
          return new pulumiAsset.FileAsset(pathResolve(path));
        }),
        remotePath: "/root/app/certs/cloudflare.cert.pem",
        connection: serverSSHConnection,
      }
    );

    // Enable Authenticated Origin Pulls on Cloudflare
    const cloudflareAuthenticatedOriginPulls =
      new cloudflare.AuthenticatedOriginPulls(
        "Cloudflare Authenticated Origin Pulls - Server",
        {
          enabled: true,
          zoneId: CLOUDFLARE_ZONE_ID,
        },
        { provider: cloudflareProvider }
      );

    // Download the Authenticated Origin Pulls certificate from Cloudflare
    const commandDownloadAopCert = new command.local.Command(
      "Local Command - Download Cloudflare Authenticated Origin Pulls certificate",
      {
        create:
          "curl --verbose --output " +
          pathResolve("./certs/authenticated_origin_pull_ca.pem") +
          " https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem",
      }
    );

    // Upload the Authenticated Origin Pulls file from Cloudflare to the Server
    const commandCopyCertificateAuthenticatedOriginPull =
      new command.remote.CopyToRemote(
        "Copy - Certificates - Authenticated Origin Pull",
        {
          source: new pulumiAsset.FileAsset(
            pathResolve("./certs/authenticated_origin_pull_ca.pem")
          ),
          remotePath: "/root/app/certs/authenticated_origin_pull_ca.pem",
          connection: serverSSHConnection,
        },
        {
          dependsOn: [commandDownloadAopCert],
        }
      );

    // Set Full(Strict) TLS on Cloudflare
    // Enable "Always Use HTTPS" on Cloudflare
    // Enable TLS 1.3 on Cloudflare
    // Set Minimum TLS version to 1.2 on Cloudflare
    new cloudflare.ZoneSettingsOverride(
      "Cloudflare Zone Settings Override",
      {
        zoneId: CLOUDFLARE_ZONE_ID,
        settings: {
          ssl: "strict",
          alwaysUseHttps: "on",
          tls13: "on",
          minTlsVersion: "1.2",
        },
      },
      { provider: cloudflareProvider }
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
          {
            hostPath: "/root/app/certs",
            containerPath: "/certs",
          },
        ],
        command: ["nginx", "-g", "daemon off;"],
        networksAdvanced: [{ name: dockerNetworkPublic.id }],
        restart: "always",
        ports: [
          {
            external: 443,
            internal: 443,
          },
        ],
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
        dependsOn: [
          dockerAppContainer,
          commandCopyCertificateCert,
          commandCopyCertificatePrivate,
          commandCopyCertificateAuthenticatedOriginPull,
        ],
      }
    );

    // Make sure Cloudflare DNS it pointing to the correct IP address
    new cloudflare.Record(
      "Cloudflare DNS Record - Server",
      {
        name: "@",
        zoneId: CLOUDFLARE_ZONE_ID,
        type: "A",
        content: server.ipv4Address,
        proxied: true,
      },
      { provider: cloudflareProvider }
    );
    return { ip: server.ipv4Address };
  },
});

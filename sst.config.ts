/// <reference path="./.sst/platform/config.d.ts" />
import { resolve as pathResolve } from "node:path";
import { writeFileSync as fsWriteFileSync } from "node:fs";
import { asset as pulumiAsset } from "@pulumi/pulumi";

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

    // Create a Server on Hetzner
    const server = new hcloud.Server("Server", {
      image: "docker-ce",
      serverType: "cx22",
      location: "nbg1",
      sshKeys: [sshKeyHetzner.id],
    });

    // Store the private SSH Key on disk to be able to pass it to the Docker
    // Provider
    const sshKeyLocalPath = sshKeyLocal.privateKeyOpenssh.apply((k) => {
      const path = "id_ed25519_hetzner";
      fsWriteFileSync(path, k, { mode: 0o600 });
      return pathResolve(path);
    });

    // Connect to the Docker Server on the Hetzner Server
    const dockerServerHetzner = new docker.Provider("Docker Server - Hetzner", {
      host: $interpolate`ssh://root@${server.ipv4Address}`,
      sshOpts: ["-i", sshKeyLocalPath, "-o", "StrictHostKeyChecking=no"],
    });

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
        dependsOn: [server],
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
      connection: {
        host: server.ipv4Address,
        user: "root",
        privateKey: sshKeyLocal.privateKeyOpenssh,
      },
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
        connection: {
          host: server.ipv4Address,
          user: "root",
          privateKey: sshKeyLocal.privateKeyOpenssh,
        },
      }
    );

    // Copy Certificates to the VPS
    const commandCopyCertificatePrivate = new command.remote.CopyToRemote(
      "Copy - Certificates - Key",
      {
        source: new pulumiAsset.FileAsset(
          pathResolve("./certs/cloudflare.key.pem")
        ),
        remotePath: "/root/app/certs/cloudflare.key.pem",
        connection: {
          host: server.ipv4Address,
          user: "root",
          privateKey: sshKeyLocal.privateKeyOpenssh,
        },
      }
    );
    const commandCopyCertificatePublic = new command.remote.CopyToRemote(
      "Copy - Certificates - Cert",
      {
        source: new pulumiAsset.FileAsset(
          pathResolve("./certs/cloudflare.cert.pem")
        ),
        remotePath: "/root/app/certs/cloudflare.cert.pem",
        connection: {
          host: server.ipv4Address,
          user: "root",
          privateKey: sshKeyLocal.privateKeyOpenssh,
        },
      }
    );
    const commandCopyCertificateAuthenticatedOriginPull =
      new command.remote.CopyToRemote(
        "Copy - Certificates - Authenticated Origin Pull",
        {
          source: new pulumiAsset.FileAsset(
            pathResolve("./certs/authenticated_origin_pull_ca.pem")
          ),
          remotePath: "/root/app/certs/authenticated_origin_pull_ca.pem",
          connection: {
            host: server.ipv4Address,
            user: "root",
            privateKey: sshKeyLocal.privateKeyOpenssh,
          },
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
      { provider: dockerServerHetzner, dependsOn: [dockerAppContainer] }
    );

    return { ip: server.ipv4Address };
  },
});

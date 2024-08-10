/// <reference path="./.sst/platform/config.d.ts" />
import { resolve as pathResolve } from "path";
import { writeFileSync as fsWriteFileSync } from "node:fs";

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

    return { ip: server.ipv4Address };
  },
});

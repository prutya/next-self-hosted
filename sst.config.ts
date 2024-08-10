/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app(input) {
    return {
      name: "next-self-hosted",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "local",
      providers: { hcloud: true, tls: true },
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
    });

    return { ip: server.ipv4Address };
  },
});

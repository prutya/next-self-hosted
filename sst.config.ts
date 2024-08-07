/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app(input) {
    return {
      name: "next-self-hosted",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "local",
      providers: { hcloud: true },
    };
  },
  async run() {},
});

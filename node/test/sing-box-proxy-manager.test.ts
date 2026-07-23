import assert from "node:assert/strict";
import test from "node:test";

import { buildSingBoxConfig, parseVlessNode } from "../src/registration/sing-box-proxy-manager.js";

test("sing-box registration proxy parses VLESS Reality into one isolated outbound", () => {
  const node = parseVlessNode("vless://00000000-0000-0000-0000-000000000001@proxy.example.test:443?security=reality&type=grpc&sni=edge.example.test&fp=chrome&pbk=public-key&sid=abcd&serviceName=registration#node");
  assert.ok(node);
  const config = buildSingBoxConfig(node, 17890) as {
    inbounds: Array<{ type: string; listen: string; listen_port: number }>;
    outbounds: Array<Record<string, unknown>>;
    route: { final: string };
  };
  assert.deepEqual(config.inbounds, [{ type: "mixed", tag: "registration-in", listen: "127.0.0.1", listen_port: 17890 }]);
  assert.equal(config.outbounds.length, 1);
  assert.equal(config.outbounds[0]?.type, "vless");
  assert.deepEqual(config.outbounds[0]?.transport, { type: "grpc", service_name: "registration" });
  assert.deepEqual(config.outbounds[0]?.tls, {
    enabled: true,
    server_name: "edge.example.test",
    insecure: false,
    utls: { enabled: true, fingerprint: "chrome" },
    reality: { enabled: true, public_key: "public-key", short_id: "abcd" },
  });
  assert.equal(config.route.final, "registration-node");
});

test("sing-box registration proxy rejects unsupported subscription entries", () => {
  assert.equal(parseVlessNode("https://proxy.example.test"), null);
  assert.equal(parseVlessNode("vless://missing-host"), null);
});

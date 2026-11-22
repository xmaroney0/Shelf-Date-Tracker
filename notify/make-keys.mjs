// Makes the key pair that lets your app send phone alerts.
// Run once:  node notify/make-keys.mjs
// It writes keys.local.txt. That file is NOT uploaded (see .gitignore).
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";

if (existsSync("keys.local.txt")) { console.log("keys.local.txt already exists. Delete it first if you really want new keys."); process.exit(0); }
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" }), priv = privateKey.export({ format: "jwk" });
const b = (s) => Buffer.from(s, "base64url");
const publicRaw = Buffer.concat([Buffer.from([4]), b(pub.x), b(pub.y)]).toString("base64url");
writeFileSync("keys.local.txt",
`VAPID_PUBLIC_KEY=${publicRaw}
VAPID_PRIVATE_KEY=${priv.d}

Public key: paste into config.js AND into the GitHub secret VAPID_PUBLIC_KEY.
Private key: paste ONLY into the GitHub secret VAPID_PRIVATE_KEY. Never put it in config.js.
`);
console.log("Wrote keys.local.txt");

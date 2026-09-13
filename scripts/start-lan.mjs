#!/usr/bin/env node

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envLocalPath = join(coreRoot, ".env.local");

export function discoverLanIPv4s(interfaces = networkInterfaces()) {
  const addresses = [];
  const seen = new Set();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family;
      if (entry.internal || (family !== "IPv4" && family !== 4) || !entry.address) {
        continue;
      }
      if (!seen.has(entry.address)) {
        seen.add(entry.address);
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

export function parseEnvLocal(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function readLocalEnv(path = envLocalPath) {
  try {
    return parseEnvLocal(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function envValue(name, processEnv, localEnv) {
  const fromProcess = processEnv[name];
  if (typeof fromProcess === "string" && fromProcess.trim()) {
    return fromProcess.trim();
  }
  const fromFile = localEnv[name];
  return typeof fromFile === "string" && fromFile.trim() ? fromFile.trim() : undefined;
}

export function resolveLanConfig({
  env = process.env,
  localEnv = readLocalEnv(),
  addresses = discoverLanIPv4s(),
  tokenFactory = () => "thebe-" + randomBytes(18).toString("base64url"),
} = {}) {
  const advertisedHost = envValue("THEBE_LAN_IP", env, localEnv) ?? addresses[0] ?? "127.0.0.1";
  const host = envValue("THEBE_HOST", env, localEnv) ?? "0.0.0.0";
  const port = envValue("THEBE_PORT", env, localEnv) ?? "8787";
  const configuredHosts = envValue("THEBE_ALLOWED_HOSTS", env, localEnv);
  const discoveredHosts = [...new Set([...addresses, advertisedHost])];
  const allowedHosts = configuredHosts ?? (discoveredHosts.join(",") || advertisedHost);
  const existingToken = envValue("THEBE_TOKEN", env, localEnv);
  const token = existingToken ?? tokenFactory();
  return {
    advertisedHost,
    host,
    port,
    allowedHosts,
    token,
    generatedToken: existingToken === undefined,
  };
}

export function persistToken(token, path = envLocalPath) {
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    const line = "THEBE_TOKEN=" + token;
    const tokenLine = /(^|\n)THEBE_TOKEN\s*=[^\n]*/;
    if (tokenLine.test(current)) {
      writeFileSync(path, current.replace(tokenLine, "$1" + line), { mode: 0o600 });
    } else {
      const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      writeFileSync(path, current + prefix + line + "\n", { mode: 0o600 });
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // The token remains valid for this process if permission tightening fails.
    }
    return true;
  } catch {
    return false;
  }
}

function startServer(config) {
  const child = spawn(process.execPath, [join(coreRoot, "dist", "serve.js")], {
    cwd: coreRoot,
    env: {
      ...process.env,
      THEBE_HOST: config.host,
      THEBE_PORT: config.port,
      THEBE_ALLOWED_HOSTS: config.allowedHosts,
      THEBE_TOKEN: config.token,
    },
    stdio: "inherit",
  });
  const forward = (signal) => child.kill(signal);
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  return child;
}

export function run() {
  const config = resolveLanConfig();
  if (config.generatedToken && !persistToken(config.token)) {
    console.warn("Could not save THEBE_TOKEN to .env.local; use the printed token for this run.");
  }
  const baseURL = "http://" + config.advertisedHost + ":" + config.port;
  console.log("Thebe Core LAN: " + baseURL);
  console.log("API docs:       " + baseURL + "/docs");
  console.log("Allowed hosts:  " + config.allowedHosts);
  console.log("UI token:       " + config.token);
  return startServer(config);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}

import { get } from "https";
import { parseLatestChangelog, parseVersionFromContent, compareSemver, parseLatestFromContent } from "./changelog.js";

const RAW_CHANGELOG_URL =
  "https://raw.githubusercontent.com/KryonixMain/Claude-Discord-Runner/main/CHANGELOG.md";

/**
 * Fetch the CHANGELOG.md from the GitHub repo (raw content).
 * Returns the raw text or null on failure.
 */
function fetchRemoteChangelog() {
  return new Promise((resolve) => {
    const req = get(RAW_CHANGELOG_URL, { timeout: 10_000 }, (res) => {
      // Follow redirects (GitHub raw sometimes redirects)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        get(res.headers.location, { timeout: 10_000 }, (res2) => {
          let data = "";
          res2.on("data", (chunk) => { data += chunk; });
          res2.on("end", () => resolve(data));
          res2.on("error", () => resolve(null));
        }).on("error", () => resolve(null));
        return;
      }

      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }

      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
      res.on("error", () => resolve(null));
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Check if a newer version is available on GitHub.
 * Returns { updateAvailable, localVersion, remoteVersion, remoteChangelog }
 * or { updateAvailable: false, error } on failure.
 */
export async function checkForUpdate() {
  const local = parseLatestChangelog();
  if (!local) {
    return { updateAvailable: false, error: "Could not read local CHANGELOG.md" };
  }

  const remoteContent = await fetchRemoteChangelog();
  if (!remoteContent) {
    return { updateAvailable: false, error: "Could not fetch remote CHANGELOG.md" };
  }

  const remoteVersion = parseVersionFromContent(remoteContent);
  if (!remoteVersion) {
    return { updateAvailable: false, error: "Could not parse remote version" };
  }

  const cmp = compareSemver(remoteVersion, local.version);

  if (cmp > 0) {
    const remoteChangelog = parseLatestFromContent(remoteContent);
    return {
      updateAvailable: true,
      localVersion: local.version,
      remoteVersion,
      remoteChangelog,
    };
  }

  return {
    updateAvailable: false,
    localVersion: local.version,
    remoteVersion,
  };
}

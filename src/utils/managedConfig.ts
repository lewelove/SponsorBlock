/**
 * Identity and server-derived keys. An administrator must never set these:
 * `userID` is the submission identity and would be shared by every managed
 * machine, `permissions` and `payments` are computed by the server.
 */
const UNMANAGED_KEYS = ["userID", "permissions", "payments"];

/**
 * Reads the administrator-provided config (`chrome.storage.managed`, fed by
 * enterprise policy). Empty when no policy is deployed or outside Chromium.
 */
export function getManagedConfig(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        try {
            if (typeof chrome === "undefined" || !chrome.storage?.managed) {
                return resolve({});
            }

            chrome.storage.managed.get(null, (items) => {
                // Reading lastError keeps Chrome from logging it when no policy exists
                void chrome.runtime.lastError;

                resolve(items ?? {});
            });
        } catch {
            resolve({});
        }
    });
}

/**
 * Overwrites the in-memory config with the managed values.
 *
 * Values are never written to `chrome.storage.sync`, so they shadow the stored
 * settings on every start and removing the policy restores the user's own
 * config. Unknown keys are dropped so policy typos cannot pollute the config.
 *
 * @param config config object to overwrite
 * @param managed values read by {@link getManagedConfig}
 * @param knownKeys config keys an administrator may set
 */
export function applyManagedConfig<T extends object>(config: T, managed: Record<string, unknown>,
        knownKeys: readonly string[]): void {
    const mutableConfig = config as Record<string, unknown>;

    for (const key in managed) {
        if (!knownKeys.includes(key) || UNMANAGED_KEYS.includes(key)) {
            continue;
        }

        mutableConfig[key] = managed[key];
    }
}

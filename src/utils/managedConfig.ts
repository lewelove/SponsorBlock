import type { SBConfig, SBStorage } from "../config";
import * as managedSchema from "../../public/managed_schema.json";

type JsonType = "boolean" | "integer" | "number" | "string" | "array" | "object";

interface SchemaProperty {
    type: string;
    enum?: unknown[];
    properties?: Record<string, SchemaProperty>;
    items?: SchemaProperty;
    additionalProperties?: SchemaProperty;
}

/**
 * Keys a policy may set, taken from the shipped schema so the browser, the
 * runtime filter and the config types cannot drift apart.
 */
export type ManagedKey = keyof typeof managedSchema.properties;

/**
 * Keys a policy must never set. Identity would be shared by every managed
 * machine, permissions and payments are computed by the server, the counters
 * are user progress or runtime state, the rest is per-device data, and skip
 * rules hold a recursive tree whose values are strings or numbers, which the
 * policy schema cannot express.
 */
export const BLOCKED_KEYS = [
    "userID", "isVip", "permissions", "payments",
    "minutesSaved", "skipCount", "sponsorTimesContributed", "submissionCountSinceCategories",
    "ytInfoPermissionGranted", "deArrowInstalled", "shownDeArrowPromotion",
    "hideDiscordLaunches", "donateClicked", "showPopupDonationCount", "categoryPillColors",
    "downvotedSegments", "navigationApiAvailable", "unsubmittedSegments", "skipProfileTemp",
    "skipRules"
] as const;

type BlockedKey = typeof BLOCKED_KEYS[number];
type ConfigKey = keyof SBConfig | keyof SBStorage;
type DeclarableKey = Exclude<ConfigKey, BlockedKey>;
type AssertNever<T extends never> = T;

/** Compile-time guarantee: the schema declares every key a policy may set, and no others. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type MissingKey = AssertNever<Exclude<DeclarableKey, ManagedKey>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type UnknownKey = AssertNever<Exclude<ManagedKey, ConfigKey>>;

const SCHEMA: { properties: Record<ManagedKey, SchemaProperty> } = managedSchema;

const TYPE_GUARDS: Record<JsonType, (value: unknown) => boolean> = {
    boolean: (value) => typeof value === "boolean",
    integer: (value) => Number.isInteger(value),
    number: (value) => typeof value === "number" && Number.isFinite(value),
    string: (value) => typeof value === "string",
    array: (value) => Array.isArray(value),
    object: (value) => typeof value === "object" && value !== null && !Array.isArray(value)
};

const warnedKeys = new Set<string>();

const APPLIED_KEY = "managedConfigApplied";

/**
 * Whether the policy already reached this browser session. Session storage is
 * wiped when the browser restarts, which is what lets a reset to the defaults
 * hold until then. Browsers without it (MV2) have no session scope, so they
 * re-apply the policy on every load.
 */
export async function policyAppliedThisSession(): Promise<boolean> {
    if (!chrome.storage?.session) {
        return false;
    }

    const values = await chrome.storage.session.get(APPLIED_KEY);

    return Boolean(values[APPLIED_KEY]);
}

export async function markPolicyApplied(): Promise<void> {
    if (!chrome.storage?.session) {
        return;
    }

    await chrome.storage.session.set({ [APPLIED_KEY]: true });
}

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
 * Values a policy sets are seeded into the config, so callers can store them
 * and the settings stay editable until the next start re-applies the policy.
 * Policy keys outside the schema are never read, and values that do not match
 * it leave the stored setting untouched.
 *
 * @param config config object to overwrite
 * @param managed values read by {@link getManagedConfig}
 * @param knownKeys config keys the target object holds
 * @returns the values that differ from the stored ones, so the caller writes
 * back only what the policy changes
 */
export function applyManagedConfig<T extends object>(config: T, managed: Record<string, unknown>,
        knownKeys: readonly string[]): Record<string, unknown> {
    const mutableConfig = config as Record<string, unknown>;
    const seeded: Record<string, unknown> = {};

    for (const key of knownKeys) {
        const property = SCHEMA.properties[key as ManagedKey];

        if (!property || !(key in managed)) {
            continue;
        }

        const value = managed[key];

        if (!isValid(property, value)) {
            warnIgnored(key);
            continue;
        }

        if (equal(mutableConfig[key], value)) {
            continue;
        }

        mutableConfig[key] = value;
        seeded[key] = value;
    }

    return seeded;
}

/**
 * Compares two policy values, ignoring the order of object keys.
 */
function equal(left: unknown, right: unknown): boolean {
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length
            && left.every((item, index) => equal(item, right[index]));
    }

    if (TYPE_GUARDS.object(left) && TYPE_GUARDS.object(right)) {
        const leftRecord = left as Record<string, unknown>;
        const rightRecord = right as Record<string, unknown>;
        const leftKeys = Object.keys(leftRecord);

        return leftKeys.length === Object.keys(rightRecord).length
            && leftKeys.every((key) => key in rightRecord && equal(leftRecord[key], rightRecord[key]));
    }

    return left === right;
}

/**
 * Checks a value against a schema property, recursing into declared subkeys.
 * Unknown subkeys are allowed, matching the way the browser validates policy.
 */
function isValid(property: SchemaProperty, value: unknown): boolean {
    if (!(TYPE_GUARDS[property.type as JsonType]?.(value) ?? false)) {
        return false;
    }

    if (property.enum && !property.enum.includes(value)) {
        return false;
    }

    if (property.properties && TYPE_GUARDS.object(value)) {
        return Object.entries(property.properties).every(([key, child]) => {
            const childValue = (value as Record<string, unknown>)[key];

            return childValue === undefined || isValid(child, childValue);
        });
    }

    if (property.additionalProperties && TYPE_GUARDS.object(value)) {
        return Object.values(value as Record<string, unknown>)
            .every((childValue) => isValid(property.additionalProperties!, childValue));
    }

    if (property.items && Array.isArray(value)) {
        return value.every((item) => isValid(property.items!, item));
    }

    return true;
}

function warnIgnored(key: string): void {
    if (warnedKeys.has(key)) {
        return;
    }

    warnedKeys.add(key);
    console.warn(`[SponsorBlock] Ignoring managed config value for "${key}": it does not match the managed schema`);
}

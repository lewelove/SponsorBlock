/**
 * @jest-environment jsdom
 */

import Config from "../src/config";
import * as managedSchema from "../public/managed_schema.json";
import { BLOCKED_KEYS, applyManagedConfig, getManagedConfig, markPolicyApplied, policyAppliedThisSession } from "../src/utils/managedConfig";

const JS_TYPES: Record<string, (value: unknown) => boolean> = {
    boolean: (value) => typeof value === "boolean",
    integer: (value) => Number.isInteger(value),
    number: (value) => typeof value === "number",
    string: (value) => typeof value === "string",
    array: (value) => Array.isArray(value),
    object: (value) => typeof value === "object" && value !== null && !Array.isArray(value)
};

const knownKeys = [
    "muteSegments", "showUpsells", "alreadyInstalled", "skipRules", "barTypes", "colorPalette",
    "categorySelections", "channelSkipProfileIDs", "userID", "isVip", "permissions", "payments",
    "unsubmittedSegments", "downvotedSegments", "skipProfileTemp", "navigationApiAvailable"
];

let warn: jest.SpyInstance;

beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    warn.mockRestore();
});

describe("Managed schema", () => {
    const defaults = { ...Config.syncDefaults, ...Config.localDefaults } as Record<string, unknown>;

    it("Declares every key with a type the extension understands", () => {
        for (const [key, property] of Object.entries(managedSchema.properties)) {
            expect([key, property.type, property.type in JS_TYPES]).toEqual([key, property.type, true]);
        }
    });

    it("Declares every key the GUI can export, and nothing else", () => {
        const declared = Object.keys(managedSchema.properties).sort();
        const configKeys = [...Object.keys(Config.syncDefaults), ...Object.keys(Config.localDefaults)]
            .filter((key) => !(BLOCKED_KEYS as readonly string[]).includes(key))
            .sort();

        expect(declared).toEqual(configKeys);
    });

    it("Agrees with the config defaults on every declared key", () => {
        for (const [key, property] of Object.entries(managedSchema.properties)) {
            expect([key, key in defaults, JS_TYPES[property.type]?.(defaults[key])]).toEqual([key, true, true]);
        }
    });
});

/**
 * Chromium parses this file with components/policy/core/common/schema.cc and
 * refuses to load the extension when it leaves that subset.
 */
describe("Chromium schema subset", () => {
    const TYPES = ["array", "boolean", "integer", "number", "object", "string"];
    const COMMON_ATTRIBUTES = ["description", "id", "sensitiveValue", "title", "type"];

    const ATTRIBUTES: Record<string, string[]> = {
        array: [...COMMON_ATTRIBUTES, "items"],
        boolean: COMMON_ATTRIBUTES,
        integer: [...COMMON_ATTRIBUTES, "enum", "maximum", "minimum"],
        number: COMMON_ATTRIBUTES,
        object: [...COMMON_ATTRIBUTES, "additionalProperties", "patternProperties", "properties", "required"],
        string: [...COMMON_ATTRIBUTES, "enum", "pattern"]
    };

    const MATCHES_TYPE: Record<string, (value: unknown) => boolean> = {
        integer: (value) => Number.isInteger(value),
        number: (value) => typeof value === "number",
        string: (value) => typeof value === "string"
    };

    type Node = {
        type: string;
        enum?: unknown[];
        items?: Node;
        properties?: Record<string, Node>;
        additionalProperties?: Node;
    };

    function* nodes(node: Node): Generator<Node> {
        yield node;

        for (const property of Object.values(node.properties ?? {})) {
            yield* nodes(property);
        }

        if (node.items) {
            yield* nodes(node.items);
        }

        if (node.additionalProperties) {
            yield* nodes(node.additionalProperties);
        }
    }

    it("Only uses types and attributes Chromium accepts", () => {
        for (const node of nodes(managedSchema as unknown as Node)) {
            expect([node, TYPES.includes(node.type)]).toEqual([node, true]);

            for (const attribute of Object.keys(node)) {
                expect([attribute, ATTRIBUTES[node.type]?.includes(attribute)]).toEqual([attribute, true]);
            }
        }
    });

    it("Only enumerates values of the node type", () => {
        for (const node of nodes(managedSchema as unknown as Node)) {
            for (const value of node.enum ?? []) {
                expect([node, value, MATCHES_TYPE[node.type]?.(value)]).toEqual([node, value, true]);
            }
        }
    });
});

describe("Apply managed config", () => {
    it("Keeps entries the schema describes by shape rather than by name", () => {
        const config = { barTypes: { sponsor: { color: "#00d400", opacity: "0.7" } }, channelSkipProfileIDs: {} };

        applyManagedConfig(config, {
            barTypes: { sponsor: { color: "#ff0033", opacity: "0.9" }, chapter: { color: "#ffd983", opacity: "0" } },
            channelSkipProfileIDs: { UC123: "profile" }
        }, knownKeys);

        expect(config).toEqual({
            barTypes: { sponsor: { color: "#ff0033", opacity: "0.9" }, chapter: { color: "#ffd983", opacity: "0" } },
            channelSkipProfileIDs: { UC123: "profile" }
        });
    });

    it("Returns only the values that differ from the stored ones", () => {
        const config = { alreadyInstalled: true, muteSegments: false, showUpsells: false };

        const seeded = applyManagedConfig(config, {
            alreadyInstalled: true,
            muteSegments: true,
            showUpsells: true
        }, knownKeys);

        expect(seeded).toEqual({ muteSegments: true, showUpsells: true });
        expect(config).toEqual({ alreadyInstalled: true, muteSegments: true, showUpsells: true });
    });

    it("Ignores the order of object keys when comparing", () => {
        const config = { barTypes: { sponsor: { color: "#00d400", opacity: "0.7" } } };

        const seeded = applyManagedConfig(config, {
            barTypes: { sponsor: { opacity: "0.7", color: "#00d400" } }
        }, knownKeys);

        expect(seeded).toEqual({});
    });

    it("Seeds nothing for blocked or invalid values", () => {
        const seeded = applyManagedConfig({}, {
            userID: "someone",
            barTypes: { sponsor: { color: 5 } }
        }, ["userID", "barTypes"]);

        expect(seeded).toEqual({});
    });

    it("Drops settings the schema cannot express", () => {
        const config = { skipRules: [] };

        applyManagedConfig(config, { skipRules: [{ predicate: { kind: "check" }, comments: [] }] }, knownKeys);

        expect(config).toEqual({ skipRules: [] });
    });

    it("Overrides declared keys and leaves the others alone", () => {
        const config = { muteSegments: false, showUpsells: true, minutesSaved: 42 };

        applyManagedConfig(config, { showUpsells: false }, knownKeys);

        expect(config).toEqual({ muteSegments: false, showUpsells: false, minutesSaved: 42 });
    });

    it("Drops keys the schema does not declare", () => {
        const config = { muteSegments: true };

        applyManagedConfig(config, { notAKey: 1, muteSegments: false }, knownKeys);

        expect(config).toEqual({ muteSegments: false });
    });

    it("Never lets the policy set identity, server state, progress or device data", () => {
        const config = { userID: "user", isVip: false, permissions: {}, payments: {}, minutesSaved: 3,
            downvotedSegments: {}, unsubmittedSegments: {}, skipProfileTemp: null, navigationApiAvailable: true };
        const managed = { userID: "admin", isVip: true, permissions: { sponsor: {} }, payments: { isVip: true },
            minutesSaved: 99, downvotedSegments: { video: [] }, unsubmittedSegments: { video: [] },
            skipProfileTemp: { time: 1, configID: "id" }, navigationApiAvailable: false };

        applyManagedConfig(config, managed, knownKeys);

        expect(config).toEqual({ userID: "user", isVip: false, permissions: {}, payments: {}, minutesSaved: 3,
            downvotedSegments: {}, unsubmittedSegments: {}, skipProfileTemp: null, navigationApiAvailable: true });
    });

    it("Keeps the stored value when the policy value does not match the schema", () => {
        const config = { muteSegments: true };

        applyManagedConfig(config, { muteSegments: "yes" }, knownKeys);
        applyManagedConfig(config, { muteSegments: 1 }, knownKeys);

        expect(config).toEqual({ muteSegments: true });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("Validates declared subkeys", () => {
        const config = { barTypes: {}, colorPalette: { red: "a", white: "b", locked: "c" },
            categorySelections: [{ name: "sponsor", option: 3 }] };

        applyManagedConfig(config, {
            barTypes: [],
            colorPalette: { red: 1 },
            categorySelections: [{ name: "sponsor", option: "AutoSkip" }]
        }, knownKeys);

        expect(config).toEqual({ barTypes: {}, colorPalette: { red: "a", white: "b", locked: "c" },
            categorySelections: [{ name: "sponsor", option: 3 }] });
    });

    it("Accepts policy values matching the schema", () => {
        const config = { barTypes: {}, colorPalette: {}, categorySelections: [] };

        applyManagedConfig(config, {
            barTypes: { sponsor: { color: "#00d400", opacity: "0.7" } },
            colorPalette: { red: "#780303" },
            categorySelections: [{ name: "sponsor", option: 3 }]
        }, knownKeys);

        expect(config).toEqual({ barTypes: { sponsor: { color: "#00d400", opacity: "0.7" } },
            colorPalette: { red: "#780303" }, categorySelections: [{ name: "sponsor", option: 3 }] });
    });

    it("Only writes keys the target config holds", () => {
        const syncConfig = { muteSegments: true };

        applyManagedConfig(syncConfig, { muteSegments: false, skipRules: [] }, ["muteSegments"]);

        expect(syncConfig).toEqual({ muteSegments: false });
    });

    it("Does nothing without a policy", () => {
        const config = { muteSegments: true };

        applyManagedConfig(config, {}, knownKeys);

        expect(config).toEqual({ muteSegments: true });
    });
});

describe("Session guard", () => {
    afterEach(() => {
        delete (global as unknown as { chrome?: unknown }).chrome;
    });

    it("Reports an applied policy once the session is marked", async () => {
        const session = new Map<string, unknown>();

        (global as unknown as { chrome: unknown }).chrome = {
            storage: {
                session: {
                    get: async (key: string) => ({ [key]: session.get(key) }),
                    set: async (values: Record<string, unknown>) => {
                        for (const [key, value] of Object.entries(values)) {
                            session.set(key, value);
                        }
                    }
                }
            }
        };

        await expect(policyAppliedThisSession()).resolves.toBe(false);

        await markPolicyApplied();

        await expect(policyAppliedThisSession()).resolves.toBe(true);
    });

    it("Reports an unapplied policy when the browser has no session storage", async () => {
        (global as unknown as { chrome: unknown }).chrome = { storage: {} };

        await expect(policyAppliedThisSession()).resolves.toBe(false);
    });
});

describe("Seed managed config", () => {
    const stubChrome = (policy: Record<string, unknown>, writes: Record<string, unknown>[]) => {
        (global as unknown as { chrome: unknown }).chrome = {
            runtime: {},
            storage: {
                managed: { get: (_keys: unknown, callback: (items: unknown) => void) => callback(policy) },
                sync: { set: (values: Record<string, unknown>) => writes.push(values) },
                local: { set: (values: Record<string, unknown>) => writes.push(values) }
            }
        };
    };

    afterEach(() => {
        delete (global as unknown as { chrome?: unknown }).chrome;
    });

    it("Writes only the values the policy changes", async () => {
        const writes: Record<string, unknown>[] = [];
        stubChrome({ showUpsells: false, hideVideoPlayerControls: true }, writes);

        Config.cachedSyncConfig = { showUpsells: true, hideVideoPlayerControls: true } as never;
        Config.cachedLocalStorage = {} as never;

        await Config.seedManagedConfig();

        expect(writes).toEqual([{ showUpsells: false }]);
        expect(Config.cachedSyncConfig.showUpsells).toBe(false);
    });

    it("Writes nothing when the stored settings already match", async () => {
        const writes: Record<string, unknown>[] = [];
        stubChrome({ showUpsells: false }, writes);

        Config.cachedSyncConfig = { showUpsells: false } as never;
        Config.cachedLocalStorage = {} as never;

        await Config.seedManagedConfig();

        expect(writes).toEqual([]);
    });
});

describe("Get managed config", () => {
    afterEach(() => {
        delete (global as unknown as { chrome?: unknown }).chrome;
    });

    it("Is empty when chrome is unavailable", async () => {
        await expect(getManagedConfig()).resolves.toEqual({});
    });

    it("Is empty when the browser has no managed storage", async () => {
        (global as unknown as { chrome: unknown }).chrome = { storage: {} };

        await expect(getManagedConfig()).resolves.toEqual({});
    });

    it("Is empty when reading the policy throws", async () => {
        (global as unknown as { chrome: unknown }).chrome = {
            runtime: {},
            storage: { managed: { get: () => { throw new Error("no policy"); } } }
        };

        await expect(getManagedConfig()).resolves.toEqual({});
    });

    it("Returns the policy values", async () => {
        (global as unknown as { chrome: unknown }).chrome = {
            runtime: {},
            storage: {
                managed: {
                    get: (_keys: unknown, callback: (items: unknown) => void) => callback({ showUpsells: false })
                }
            }
        };

        await expect(getManagedConfig()).resolves.toEqual({ showUpsells: false });
    });
});

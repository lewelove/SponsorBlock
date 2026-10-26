import { applyManagedConfig, getManagedConfig } from "../src/utils/managedConfig";

const knownKeys = ["muteSegments", "showUpsells", "userID", "permissions", "payments"];

describe("Apply managed config", () => {
    it("Overrides declared keys and leaves the others alone", () => {
        const config = { muteSegments: false, showUpsells: true, minutesSaved: 42 };

        applyManagedConfig(config, { showUpsells: false }, knownKeys);

        expect(config).toEqual({ muteSegments: false, showUpsells: false, minutesSaved: 42 });
    });

    it("Never lets the policy touch identity or server-derived keys", () => {
        const config = { userID: "user", permissions: {}, payments: {} };
        const managed = { userID: "admin", permissions: { sponsor: {} }, payments: { isVip: true } };

        applyManagedConfig(config, managed, knownKeys);

        expect(config).toEqual({ userID: "user", permissions: {}, payments: {} });
    });

    it("Drops keys the extension does not know", () => {
        const config = { muteSegments: true };

        applyManagedConfig(config, { notAKey: 1, muteSegments: false }, knownKeys);

        expect(config).toEqual({ muteSegments: false });
    });

    it("Does nothing without a policy", () => {
        const config = { muteSegments: true };

        applyManagedConfig(config, {}, knownKeys);

        expect(config).toEqual({ muteSegments: true });
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

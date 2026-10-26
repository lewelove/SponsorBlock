import { stringifyConfig } from "../src/utils/genericUtils";

describe("Stringify config", () => {
    it("Sorts keys so two exports of the same settings are identical", () => {
        const left = stringifyConfig({ b: 1, a: { d: 2, c: 3 } });
        const right = stringifyConfig({ a: { c: 3, d: 2 }, b: 1 });

        expect(left).toEqual(right);
    });

    it("Indents every level", () => {
        expect(stringifyConfig({ a: { b: [1] } })).toEqual([
            "{",
            "  \"a\": {",
            "    \"b\": [",
            "      1",
            "    ]",
            "  }",
            "}"
        ].join("\n"));
    });

    it("Keeps the order of arrays", () => {
        expect(stringifyConfig([{ y: 1 }, { x: 2 }])).toEqual([
            "[",
            "  {",
            "    \"y\": 1",
            "  },",
            "  {",
            "    \"x\": 2",
            "  }",
            "]"
        ].join("\n"));
    });
});

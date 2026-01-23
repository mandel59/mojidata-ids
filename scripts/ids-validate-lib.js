// ids-validate-lib.js
// SPDX-FileCopyrightText: 2026 Ryusei Yamaguchi <mandel59@gmail.com>
// SPDX-License-Identifier: MIT-0

const BINARY_OPS = new Set(["⿰", "⿱", "⿴", "⿵", "⿶", "⿷", "⿸", "⿹", "⿺", "⿼", "⿽", "⿻", "㇯"]);
const TERNARY_OPS = new Set(["⿲", "⿳"]);
const UNARY_OPS = new Set(["⿾", "⿿", "〾"]);

const SOURCE_ORDER = [
    "G",
    "H",
    "M",
    "T",
    "J",
    "K",
    "P",
    "V",
    "U",
    "S",
    "B",
    "UCS2003",
    "X",
    "Z",
];
const SOURCE_ORDER_MAP = new Map(SOURCE_ORDER.map((s, i) => [s, i]));
const SOURCE_LETTERS = new Set(["G", "H", "M", "T", "J", "K", "P", "V", "U", "S", "B", "X", "Z"]);

/**
 * @typedef {{ message: string, index?: number }} ValidationIssue
 */

/**
 * Validate the IDS expression part between ^ and $ (e.g. "⿱山由").
 * @param {string} ids
 * @returns {{ ok: true } | { ok: false, issues: ValidationIssue[] }}
 */
export function validateIdsExpression(ids) {
    /** @type {ValidationIssue[]} */
    const issues = [];

    const s = String(ids ?? "");
    if (s.trim() === "") {
        issues.push({ message: "IDS must not be empty." });
        return { ok: false, issues };
    }
    if (/[\t\r\n]/.test(s)) {
        issues.push({ message: "IDS must not contain tabs/newlines." });
        return { ok: false, issues };
    }
    if (s.includes("^") || s.includes("$")) {
        issues.push({ message: "IDS must not contain '^' or '$'." });
        return { ok: false, issues };
    }

    let i = 0;
    const len = s.length;

    function isVariationSelector(cp) {
        // VS1..VS16
        if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
        // IVS (Ideographic Variation Selectors)
        if (cp >= 0xe0100 && cp <= 0xe01ef) return true;
        return false;
    }

    /** @returns {{ type: 'component', raw: string } | { type: 'op', op: string, arity: number } | null} */
    function readToken() {
        if (i >= len) return null;
        const ch0 = s[i];
        if (ch0 === "{") {
            const end = s.indexOf("}", i + 1);
            if (end === -1) {
                issues.push({ message: "Unclosed '{' in IDS.", index: i });
                i = len;
                return null;
            }
            const inner = s.slice(i + 1, end);
            if (!/^\d+$/.test(inner)) {
                issues.push({ message: "Unencoded component must be {<digits>} (e.g. {11}).", index: i });
            }
            const raw = s.slice(i, end + 1);
            i = end + 1;
            return { type: "component", raw };
        }

        const cp = s.codePointAt(i);
        if (cp == null) return null;
        let raw = String.fromCodePoint(cp);
        i += cp > 0xffff ? 2 : 1;

        if (UNARY_OPS.has(raw)) return { type: "op", op: raw, arity: 1 };
        if (TERNARY_OPS.has(raw)) return { type: "op", op: raw, arity: 3 };
        if (BINARY_OPS.has(raw)) return { type: "op", op: raw, arity: 2 };

        // Treat variation selectors (VS / IVS) as part of the preceding component.
        while (i < len) {
            const nextCp = s.codePointAt(i);
            if (nextCp == null || !isVariationSelector(nextCp)) break;
            raw += String.fromCodePoint(nextCp);
            i += nextCp > 0xffff ? 2 : 1;
        }

        if (/[0-9]/.test(raw)) {
            issues.push({ message: "Digits are only allowed inside {<digits>} in IDS.", index: i - 1 });
        }

        return { type: "component", raw };
    }

    /** @returns {boolean} */
    function parseExpr() {
        const start = i;
        const tok = readToken();
        if (tok == null) {
            issues.push({ message: "Unexpected end of IDS." });
            return false;
        }
        if (tok.type === "component") {
            return true;
        }
        for (let k = 0; k < tok.arity; k++) {
            if (!parseExpr()) {
                issues.push({ message: `Operator '${tok.op}' is missing operand(s).`, index: start });
                return false;
            }
        }
        return true;
    }

    parseExpr();
    if (i < len) {
        issues.push({ message: "Extra trailing characters in IDS.", index: i });
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true };
}

/**
 * Validate the source tag inside $(...) (e.g. "GTJKP", "TJ[K]P", "[G][T]", "UCS2003").
 * @param {string} source
 * @returns {{ ok: true } | { ok: false, issues: ValidationIssue[] }}
 */
export function validateSourceTag(source) {
    /** @type {ValidationIssue[]} */
    const issues = [];

    const s = String(source ?? "");
    if (s.trim() === "") {
        issues.push({ message: "Source must not be empty." });
        return { ok: false, issues };
    }
    if (/[\t\r\n ]/.test(s)) {
        issues.push({ message: "Source must not contain whitespace." });
        return { ok: false, issues };
    }
    if (s.includes("(") || s.includes(")") || s.includes("$")) {
        issues.push({ message: "Source must not contain '(', ')', or '$'." });
        return { ok: false, issues };
    }

    /** @type {{ raw: string, base: string, order: number, index: number }[]} */
    const tokens = [];
    let i = 0;
    while (i < s.length) {
        if (s.startsWith("UCS2003", i)) {
            const base = "UCS2003";
            tokens.push({ raw: base, base, order: SOURCE_ORDER_MAP.get(base) ?? 9999, index: i });
            i += base.length;
            continue;
        }

        const c = s[i];
        if (c === "[") {
            const end = s.indexOf("]", i + 1);
            if (end === -1) {
                issues.push({ message: "Unclosed '[' in source tag.", index: i });
                break;
            }
            const inner = s.slice(i + 1, end);
            if (inner.length !== 1 || !SOURCE_LETTERS.has(inner)) {
                issues.push({ message: `Invalid virtual source designation '[${inner}]'.`, index: i });
            } else {
                const base = inner;
                tokens.push({ raw: `[${inner}]`, base, order: SOURCE_ORDER_MAP.get(base) ?? 9999, index: i });
            }
            i = end + 1;
            continue;
        }

        if (c != null && SOURCE_LETTERS.has(c)) {
            const base = c;
            tokens.push({ raw: c, base, order: SOURCE_ORDER_MAP.get(base) ?? 9999, index: i });
            i += 1;
            continue;
        }

        issues.push({ message: `Invalid character in source tag: '${c ?? ""}'.`, index: i });
        i += 1;
    }

    let lastOrder = -1;
    for (const t of tokens) {
        if (t.order < lastOrder) {
            issues.push({
                message: `Source designations must follow the standard order (e.g. GHTJKPVUSB...). Offending token: '${t.raw}'.`,
                index: t.index,
            });
            break;
        }
        lastOrder = t.order;
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true };
}

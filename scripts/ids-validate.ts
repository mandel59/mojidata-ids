// ids-validate.ts
// SPDX-FileCopyrightText: 2026 Ryusei Yamaguchi <mandel59@gmail.com>
// SPDX-License-Identifier: MIT-0

// Validate IDS.TXT compatible file.
//
// Usage:
//   bun run scripts/ids-validate.ts <ids-file>

import { createReadStream } from "node:fs";
import { stdin } from "node:process";
import * as readline from "node:readline/promises";
import { validateIdsExpression, validateSourceTag } from "./ids-validate-lib.js";

if (import.meta.main) {
    await main();
}

async function main() {
    const args = Bun.argv.slice(2);
    const filePath = args[0];
    if (filePath == null || filePath.trim() === "" || filePath.startsWith("-")) {
        console.error("Usage: bun run scripts/ids-validate.ts <ids-file | ->");
        process.exitCode = 2;
        return;
    }

    const input = filePath === "-" ? stdin : createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({
        input,
        crlfDelay: Infinity,
    });

    let errorCount = 0;
    let recordCount = 0;
    let lineNo = 0;

    for await (const line of rl) {
        lineNo++;
        const raw = String(line ?? "");
        if (raw.trim() === "" || raw.startsWith("#")) continue;
        const cols = raw.split("\t");
        if (cols.length < 2) continue;

        const codepoint = cols[0] ?? "";
        const char = cols[1] ?? "";
        const ctx = `L${lineNo} ${codepoint} ${char}`;

        let dataIndex = 0;
        let sawUnknown = false;
        const seenSources = new Map<string, number>();
        recordCount++;

        for (const col of cols.slice(2)) {
            if (col === "") continue;
            if (col.startsWith("*")) continue;
            if (col.startsWith("^")) {
                const m = col.match(/^\^(.*)\$\((.*)\)$/);
                if (m?.[1] == null || m[2] == null) {
                    report(`Invalid IDS field (expected ^<ids>$(<source>)): ${col}`, ctx);
                    errorCount++;
                    dataIndex++;
                    continue;
                }
                const ids = m[1];
                const source = m[2];

                const idsRes = validateIdsExpression(ids);
                if (!idsRes.ok) {
                    report(`data[${dataIndex}].ids: ${idsRes.issues[0]?.message ?? "Invalid IDS."}`, ctx);
                    errorCount++;
                }

                const srcRes = validateSourceTag(source);
                if (!srcRes.ok) {
                    report(`data[${dataIndex}].source: ${srcRes.issues[0]?.message ?? "Invalid source."}`, ctx);
                    errorCount++;
                } else {
                    if (source !== "X" && source !== "Z") {
                        const prev = seenSources.get(source);
                        if (prev != null) {
                            report(
                                `data[${dataIndex}].source: Duplicate source '${source}' (already used at data[${prev}].source).`,
                                ctx,
                            );
                            errorCount++;
                        } else {
                            seenSources.set(source, dataIndex);
                        }
                    }
                }
                dataIndex++;
                continue;
            }
            sawUnknown = true;
        }

        if (sawUnknown) {
            report("Unknown field(s) found after codepoint/char.", ctx);
            errorCount++;
        }
    }

    if (errorCount > 0) {
        console.error(`\nFound ${errorCount} error(s) in ${recordCount} record(s).`);
        process.exitCode = 1;
    } else {
        console.log(`OK (${recordCount} record(s)).`);
    }
}

function report(message: string, ctx: string) {
    console.error(`[${ctx}] ${message}`);
}

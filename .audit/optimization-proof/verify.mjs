import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
// Resolve all inputs from this file, independent of the caller's directory.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.TZ = 'UTC';
const baseline = execFileSync('git', ['rev-parse', process.argv[2] ?? '735af1e381258b7115df025361c79d748b9de88b'], { cwd: repo, encoding: 'utf8' }).trim();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
let assertions = 0;
const eq = (actual, expected) => { assert.deepStrictEqual(actual, expected); assertions++; };
eq(baseline !== head, true);
let changedSource = false;
const require = createRequire(path.join(repo, 'package.json'));
const ts = require('typescript');
const root = fs.mkdtempSync(path.join(tmpdir(), 'pi-quota-proof-'));
const originalNow = Date.now;
const originalNumberFormat = Intl.NumberFormat;
const originalLocale = Number.prototype.toLocaleString;
try {
    const files = execFileSync('git', ['ls-files', 'src'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(x => x.endsWith('.ts') && !x.endsWith('.d.ts'));
    for (const variant of ['head', 'current']) {
        fs.mkdirSync(path.join(root, variant), { recursive: true });
        fs.writeFileSync(path.join(root, variant, 'package.json'), '{"type":"module"}');
        for (const file of files) {
            const source = variant === 'head' ? execFileSync('git', ['show', `${baseline}:${file}`], { cwd: repo, encoding: 'utf8' }) : fs.readFileSync(path.join(repo, file), 'utf8');
            if (variant === 'current' && source !== execFileSync('git', ['show', `${baseline}:${file}`], { cwd: repo, encoding: 'utf8' }))
                changedSource = true;
            const dest = path.join(root, variant, file.replace(/\.ts$/, '.js'));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
        }
    }
    eq(changedSource, true);
    const load = (v, m) => import(pathToFileURL(path.join(root, v, 'src', m + '.js')).href);
    const nf = Intl.NumberFormat, locale = Number.prototype.toLocaleString;
    let constructions = 0, calls = 0;
    Intl.NumberFormat = new Proxy(nf, { construct(t, a) { constructions++; return Reflect.construct(t, a); } });
    Number.prototype.toLocaleString = function (...args) { calls++; return Reflect.apply(locale, this, args); };
    const base = { f: await load('head', 'format'), d: await load('head', 'quota-dimensions'), q: await load('head', 'quota') };
    const headStartup = constructions;
    const cur = { f: await load('current', 'format'), d: await load('current', 'quota-dimensions'), q: await load('current', 'quota') };
    const currentStartup = constructions - headStartup;
    eq(currentStartup, 0);
    const metric = value => ({ name: 'balance', value, unit: 'USD', observedAt: 0, source: 'provider' });
    cur.f.formatProviderMetric(metric(1));
    eq(constructions - headStartup, 1);
    cur.f.formatProviderMetric(metric(2));
    eq(constructions - headStartup, 1);
    cur.f.formatProviderMetric(metric(100));
    eq(constructions - headStartup, 2);
    cur.f.formatProviderMetric(metric(101));
    eq(constructions - headStartup, 2);
    const values = [-Infinity, -123, -0, 0, .004, .005, .015, 1.005, 99.994, 99.995, 99.999, 100, 100.005, 100.125, 999.999, 1234.5, 1e20, NaN, Infinity];
    for (const value of values)
        for (const unit of ['USD', 'CNY', 'EUR', 'GBP', 'CREDIT', 'credits', 'widgets']) {
            const metric = { name: 'balance', value, unit, observedAt: 0, source: 'provider' };
            eq(cur.f.formatProviderMetric(metric), base.f.formatProviderMetric(metric));
        }
    const now = Date.UTC(2026, 0, 1);
    Date.now = () => now;
    const numbers = [undefined, -1, 0, 1, 100, NaN, Infinity, -Infinity];
    const dims = [{ name: 'weekly', remaining: 80, limit: 100 }, { name: '5h', remaining: 70, limit: 100 }, { name: 'weekly_sonnet', remaining: 20, limit: 100 }, { name: 'weekly_opus', remaining: 30, limit: 100 }];
    const cases = [[], dims, [...dims].reverse()];
    for (const remaining of numbers)
        for (const limit of numbers)
            for (const resetAt of [undefined, now - 1, now, now + 1])
                for (const source of ['provider', 'fallback'])
                    cases.push([{ name: ' FIVE-HOUR ', remaining, limit, resetAt, source }, { name: 'five_hour', remaining: 50, limit: 100 }, ...dims]);
    for (const ds of cases)
        for (const names of [[], ['weekly', '5h'], ['5h', 'weekly'], ['five_hour'], ['missing']]) {
            eq(cur.d.findCurrentDimensionByNames(ds, names, now), base.d.findCurrentDimensionByNames(ds, names, now));
            eq(cur.d.findDimensionByNames(ds, names), base.d.findDimensionByNames(ds, names));
        }
    let demo;
    for (const source of ['provider', 'codexbar', 'subscription', 'headers', 'fallback'])
        for (const provider of ['anthropic', 'openai-codex', 'example'])
            for (const model of ['claude-sonnet', 'claude-opus', 'model'])
                for (const ds of cases) {
                    const ref = { provider, model };
                    const observation = { ...ref, adapter: 'fake', source, status: 200, observedAt: now, updatedAt: now, dimensions: ds.map(d => ({ ...d, source, observedAt: now })), metrics: [] };
                    const state = { version: 1, observations: { [`${provider}/${model}`]: observation } };
                    const config = { adapters: [{ name: 'fake', provider: '*', fallback: { limit: 100, windowSeconds: 3600, dimension: '5h' } }] };
                    for (const fn of ['selectFooterQuotaForModel', 'selectQuotaForModel', 'selectProviderMetricsForModel'])
                        eq(cur.q[fn](state, config, ref, now), base.q[fn](state, config, ref, now));
                    const b = base.q.selectFooterQuotaForModel(state, config, ref, now), c = cur.q.selectFooterQuotaForModel(state, config, ref, now);
                    eq(cur.f.formatCompactFooterText(c?.segments ?? [], now), base.f.formatCompactFooterText(b?.segments ?? [], now));
                    if (source === 'subscription' && provider === 'anthropic' && model === 'claude-sonnet' && ds === dims)
                        demo = cur.f.formatCompactFooterText(c?.segments ?? [], now);
                }
    for (const impl of [base, cur])
        for (const fn of ['selectFooterQuotaForModel', 'selectQuotaForModel', 'selectProviderMetricsForModel'])
            eq(impl.q[fn]({ observations: {} }, { adapters: [] }, { provider: 'x', model: 'y' }, now), base.q[fn]({ observations: {} }, { adapters: [] }, { provider: 'x', model: 'y' }, now));
    function examined(impl) { let reads = 0; const ds = Array.from({ length: 1000 }, (_, i) => ({ name: i ? 'other' : '5h', remaining: 1, limit: 2, get resetAt() { reads++; return undefined; } })); impl.d.findCurrentDimensionByNames(ds, ['5h'], now); return reads; }
    function adapterReads(impl, source) { let reads = 0; const ref = { provider: 'example', model: 'model' }; const state = { observations: { 'example/model': { ...ref, source, dimensions: [{ name: '5h', limit: 100, remaining: 80, observedAt: now, source }], observedAt: now } } }; const config = { get adapters() { reads++; return [{ fallback: { limit: 100, windowSeconds: 3600 } }]; } }; impl.q.selectFooterQuotaForModel(state, config, ref, now); return reads; }
    const localeCounts = [];
    for (const impl of [base, cur]) {
        calls = 0;
        for (let i = 0; i < 1000; i++)
            impl.f.formatProviderMetric({ value: 12.5, unit: 'USD' });
        localeCounts.push(calls);
    }
    const expirationReads = [examined(base), examined(cur)];
    eq(expirationReads, [1000, 1]);
    eq(localeCounts, [1000, 0]);
    const adapterCounts = {};
    for (const source of ['provider', 'subscription', 'fallback']) {
        adapterCounts[source] = [adapterReads(base, source), adapterReads(cur, source)];
        eq(adapterCounts[source], source === 'fallback' ? [1, 1] : [1, 0]);
    }
    console.log(`Baseline: ${baseline}`);
    console.log(`HEAD: ${head}; optimized inputs: working-tree src files`);
    console.log(`PASS: ${assertions} assertions, including differential equality and expected operation counts.`);
    console.log(`Frozen now: ${now}; TZ: ${process.env.TZ}`);
    console.log(`Expiration reads (baseline, optimized): ${JSON.stringify(expirationReads)}`);
    console.log(`Locale calls (baseline, optimized): ${JSON.stringify(localeCounts)}`);
    console.log(`Adapter getter reads (baseline, optimized): ${JSON.stringify(adapterCounts)}`);
    console.log(`Formatter constructors at import (baseline, optimized): ${headStartup}, ${currentStartup}`);
    console.log('Optimized formatter constructors: 0 at import; 1 after first small value; 1 after reuse; 2 after first large value; 2 after reuse. All asserted.');
    console.log(`Fake-data footer, equal in both versions: ${demo}`);
    console.log('Expiration proxy counts resetAt getter reads in 1000 dimensions, with the first named 5h and all resetAt values undefined.');
    console.log('Locale proxy counts Number.prototype.toLocaleString calls for 1000 USD metrics with value 12.5. It does not count ICU work.');
    console.log('Adapter proxy counts config.adapters getter reads for one footer selection per source. It does not measure adapter or network execution.');
    console.log('Constructor proxy counts Intl.NumberFormat construction, not allocations inside ICU.');
    console.log('No elapsed time measured. Synthetic fixtures only; live APIs and host runtime integration unverified.');
}
finally {
    Intl.NumberFormat = originalNumberFormat;
    Number.prototype.toLocaleString = originalLocale;
    Date.now = originalNow;
    fs.rmSync(root, { recursive: true, force: true });
}

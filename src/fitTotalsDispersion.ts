import { readFileSync } from 'node:fs';
import { describeErrorWithStack } from './config.js';
import { printError, printLine } from './console.js';
import {
  CLOSE_SPREAD_SOURCE,
  fitTotalsDispersionMoments,
  KNOWN_APPROXIMATIONS,
  marginalPmfCheck,
  PMF_CHECK_T_MAX,
  PMF_CHECK_T_MIN,
  PRIMARY_FIT_BASIS,
  PRIMARY_FIT_METHOD,
  PUSH_ANCHOR_BAND,
  REFIT_PLAN,
  RETROSHEET_FIT_WINDOW,
  TOTALS_DISPERSION_PARAMETER_VERSION,
  TOTALS_DISPERSION_PARAMETERIZATION,
  totalsDispersionArtifactSchema,
} from './dispersion.js';
import { parseInhouseTotalsDataset } from './inhouseTotals.js';
import { writeText } from './records.js';
import { classifyOuts, parseRetrosheetDataset, RETROSHEET_ATTRIBUTION } from './retrosheet.js';
import type { TotalsDispersionArtifact } from './dispersion.js';

/**
 * ospex-benchmark dispersion fit — computes the published TOTALS_V1_PROVISIONAL
 * negative-binomial dispersion parameter from the two committed datasets
 * (Retrosheet finals + in-house closing totals) and writes the versioned
 * parameter artifact the totals ladder consumes. Method, gates, and known
 * approximations: docs/TOTALS_DISPERSION.md. Deterministic given the input
 * datasets — only generatedAt varies between runs.
 */

class UsageError extends Error {}

const USAGE = `Usage: yarn fit:totals --inhouse PATH [options]

Options:
  --inhouse PATH     In-house totals dataset (from yarn extract:totals). Required.
  --retrosheet PATH  Retrosheet dataset (from yarn ingest:retrosheet).
                     Default: data/retrosheet-mlb-totals-2023-2025.ndjson
  --out PATH         Artifact path.
                     Default: data/totals-dispersion-TOTALS_V1_PROVISIONAL.json
  -h, --help         Show this help.`;

interface CliOptions {
  inhousePath: string;
  retrosheetPath: string;
  outPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  let inhousePath: string | null = null;
  let retrosheetPath = 'data/retrosheet-mlb-totals-2023-2025.ndjson';
  let outPath = 'data/totals-dispersion-TOTALS_V1_PROVISIONAL.json';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--inhouse':
        inhousePath = next();
        break;
      case '--retrosheet':
        retrosheetPath = next();
        break;
      case '--out':
        outPath = next();
        break;
      case '-h':
      case '--help':
        printLine(USAGE);
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown argument: ${arg ?? ''}`);
    }
  }
  if (inhousePath === null) throw new UsageError('--inhouse is required');
  return { inhousePath, retrosheetPath, outPath };
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  printLine(`ospex-benchmark dispersion fit — ${TOTALS_DISPERSION_PARAMETER_VERSION}`);

  const retrosheet = parseRetrosheetDataset(readFileSync(options.retrosheetPath, 'utf8'));
  const inhouse = parseInhouseTotalsDataset(readFileSync(options.inhousePath, 'utf8'));
  printLine(
    `inputs: ${retrosheet.games.length} Retrosheet finals (${retrosheet.meta.seasons.join(', ')}), ` +
      `${inhouse.records.length} captured closing totals (${inhouse.meta.pairs} with finals)`,
  );

  // Settlement basis: forfeits and rain-shortened games are excluded (books
  // void unresolved totals on shortened games); extra innings are included —
  // that is what totals bets settle on. Regulation-only is the published
  // sensitivity variant showing how little the extras tail moves the fit.
  const nonForfeit = retrosheet.games.filter((game) => game.forfeit === null);
  const nForfeitsExcluded = retrosheet.games.length - nonForfeit.length;
  const classified = nonForfeit.map(
    (game) => [classifyOuts(game.outs), game.awayScore + game.homeScore] as const,
  );
  const fullTotals = classified
    .filter(([classification]) => classification !== 'shortened')
    .map(([, total]) => total);
  const regulationTotals = classified
    .filter(([classification]) => classification === 'regulation')
    .map(([, total]) => total);
  const nShortenedExcluded = classified.length - fullTotals.length;
  const nExtraInnings = fullTotals.length - regulationTotals.length;
  const nCompletedLater = nonForfeit.filter((game) => game.completedLater).length;

  const closeLines = inhouse.records.map((record) => record.line);

  const primary = fitTotalsDispersionMoments({ totals: fullTotals, closeLines });
  const regulation = fitTotalsDispersionMoments({ totals: regulationTotals, closeLines });
  const pmfCheck = marginalPmfCheck(
    fullTotals,
    closeLines,
    primary.k,
    PMF_CHECK_T_MIN,
    PMF_CHECK_T_MAX,
  );

  const pairs = inhouse.records.filter((record) => record.final !== null);
  const integerLinePairs = pairs.filter((record) => Number.isInteger(record.line));
  const pushes = integerLinePairs.filter(
    (record) => record.final !== null && record.final.total === record.line,
  );

  const lockTimeRange = inhouse.meta.lockTimeRange;
  if (lockTimeRange === null) {
    throw new Error('in-house dataset has no records — nothing to fit the close spread on');
  }

  const artifact: TotalsDispersionArtifact = {
    parameterVersion: TOTALS_DISPERSION_PARAMETER_VERSION,
    sport: 'mlb',
    market: 'total',
    distribution: 'negative-binomial',
    parameterization: TOTALS_DISPERSION_PARAMETERIZATION,
    k: primary.k,
    primaryFit: {
      basis: PRIMARY_FIT_BASIS,
      method: PRIMARY_FIT_METHOD,
      retrosheet: {
        dataset: options.retrosheetPath,
        seasons: retrosheet.meta.seasons,
        window: RETROSHEET_FIT_WINDOW,
        nGames: primary.n,
        nForfeitsExcluded,
        nShortenedExcluded,
        nExtraInnings,
        nCompletedLater,
        marginalMean: primary.marginalMean,
        marginalVariance: primary.marginalVariance,
      },
      closeSpread: {
        dataset: options.inhousePath,
        source: CLOSE_SPREAD_SOURCE,
        n: primary.closeN,
        confidence: inhouse.meta.confidence,
        lockTimeRange,
        lineMean: primary.closeLineMean,
        lineVariance: primary.closeLineVariance,
      },
      conditionalVariance: primary.conditionalVariance,
    },
    sensitivity: {
      regulationOnly: {
        nGames: regulation.n,
        marginalMean: regulation.marginalMean,
        marginalVariance: regulation.marginalVariance,
        conditionalVariance: regulation.conditionalVariance,
        k: regulation.k,
      },
    },
    anchors: {
      pushProbabilityAtLineEqualMean: primary.pushAnchors,
      acceptanceBand: [PUSH_ANCHOR_BAND[0], PUSH_ANCHOR_BAND[1]],
      marginalPmfCheck: pmfCheck,
      inHousePairsObserved: {
        n: pairs.length,
        integerLinePairs: integerLinePairs.length,
        pushes: pushes.length,
      },
    },
    knownApproximations: [...KNOWN_APPROXIMATIONS],
    refitPlan: REFIT_PLAN,
    attribution: RETROSHEET_ATTRIBUTION,
    generatedAt: new Date().toISOString(),
  };
  // Writer-side validation against the exact schema the ladder will read
  // with — the artifact can never drift from its own read contract.
  totalsDispersionArtifactSchema.parse(artifact);
  writeText(options.outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  printLine('');
  printLine(
    `primary (settlement) fit: k = ${primary.k.toFixed(4)} on ${primary.n} finals ` +
      `(mean ${primary.marginalMean.toFixed(4)}, variance ${primary.marginalVariance.toFixed(4)}; ` +
      `close-spread variance ${primary.closeLineVariance.toFixed(4)} over ${primary.closeN} lines)`,
  );
  printLine(
    `regulation-only sensitivity: k = ${regulation.k.toFixed(4)} on ${regulation.n} finals`,
  );
  printLine('push anchors P(T=L | mu=L):');
  for (const anchor of primary.pushAnchors) {
    printLine(`  L=${anchor.line}: ${(100 * anchor.pushProbability).toFixed(2)}%`);
  }
  printLine('marginal pmf check (model = NB mixture over recentered closing lines):');
  for (const row of pmfCheck.rows) {
    printLine(
      `  T=${row.t}: empirical ${(100 * row.empirical).toFixed(2)}% vs model ${(100 * row.model).toFixed(2)}%`,
    );
  }
  printLine(
    `in-house pairs observed: ${pairs.length} (${integerLinePairs.length} integer-line, ` +
      `${pushes.length} pushes) — observational until the TOTALS_V1 refit`,
  );
  printLine('');
  printLine(`artifact: ${options.outPath}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof UsageError) {
    printError(`error: ${error.message}`);
    printError('');
    printError(USAGE);
    process.exitCode = 2;
  } else {
    printError(describeErrorWithStack(error));
    process.exitCode = 1;
  }
}

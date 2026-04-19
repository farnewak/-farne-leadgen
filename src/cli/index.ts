// Single CLI entry — dispatches to subcommand modules. Each case returns
// explicitly so a missing `break` cannot cause fall-through into a later
// command (see audit/export: both have side effects).
//
// Invoked via:
//   npx tsx src/cli/index.ts audit --limit 5
//   npx tsx src/cli/index.ts discover --plz 1070 --max 100
//   npx tsx src/cli/index.ts label osm:node:42 INTERESSIERT --channel CALL
//   npx tsx src/cli/index.ts export-labels --output training.jsonl
const cmd = process.argv[2];

async function dispatch(): Promise<void> {
  switch (cmd) {
    case "discover": {
      const m = await import("./discover.js");
      await m.main();
      return;
    }
    case "audit": {
      const m = await import("./audit.js");
      await m.main();
      return;
    }
    case "export": {
      const m = await import("./export.js");
      await m.main();
      return;
    }
    case "label": {
      const m = await import("./label.js");
      await m.main();
      return;
    }
    case "export-labels": {
      const m = await import("./export-labels.js");
      await m.main();
      return;
    }
    default:
      console.error(
        "Usage: leadgen {discover|audit|export|label|export-labels}",
      );
      process.exit(1);
  }
}

dispatch().catch((e) => {
  console.error(e);
  process.exit(1);
});

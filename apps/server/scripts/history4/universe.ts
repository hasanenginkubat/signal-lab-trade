/** Bugünkü otomatik evreni (B) DIR/universeB.json dosyasına yazar. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectUniverse } from "../../src/binance/rest";
import { config } from "../../src/config";

selectUniverse(config.universe).then((s) => {
  writeFileSync(join(process.env.DIR!, "universeB.json"), JSON.stringify(s));
  console.log(s.length, s.join(","));
});

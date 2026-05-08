import { Resvg } from "@resvg/resvg-js";
import * as fs from "fs";

const svg = fs.readFileSync("logo.svg", "utf-8");
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 512 },
  background: "rgba(0,0,0,0)",
});
const pngData = resvg.render().asPng();
fs.writeFileSync("logo.png", pngData);
console.log(`✓ logo.png généré (${pngData.length} bytes)`);

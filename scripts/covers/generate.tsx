import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

import { BtwCover, metadata as btwMetadata } from "./BtwCover.tsx";
import { loadFonts } from "./fonts.ts";
import { metadata as personalMetadata, PersonalCover } from "./PersonalCover.tsx";
import { metadata as questionsMetadata, QuestionsCover } from "./QuestionsCover.tsx";
import { metadata as resourcesMetadata, ResourcesCover } from "./ResourcesCover.tsx";
import { metadata as voiceMetadata, opencodeMetadata, VoiceCover } from "./VoiceCover.tsx";
import { metadata as whimsicalMetadata, WhimsicalCover } from "./WhimsicalCover.tsx";

const fonts = await loadFonts();
const covers = [
  { metadata: btwMetadata, element: <BtwCover /> },
  { metadata: questionsMetadata, element: <QuestionsCover /> },
  { metadata: resourcesMetadata, element: <ResourcesCover /> },
  { metadata: voiceMetadata, element: <VoiceCover /> },
  { metadata: opencodeMetadata, element: <VoiceCover host="opencode" /> },
  { metadata: personalMetadata, element: <PersonalCover /> },
  { metadata: whimsicalMetadata, element: <WhimsicalCover /> },
];

for (const { metadata, element } of covers) {
  const svg = await satori(element, { width: 1280, height: 800, fonts });
  const docsDir = new URL(`../../../packages/${metadata.directory}/docs/`, import.meta.url);
  const pngOutput = new URL("cover.png", docsDir);
  await mkdir(docsDir, { recursive: true });
  await writeFile(pngOutput, new Resvg(svg).render().asPng());
  process.stdout.write(`Generated ${fileURLToPath(pngOutput)}\n`);
}

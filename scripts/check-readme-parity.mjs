import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const documents = {
  english: await readFile(path.join(repositoryRoot, "README.md"), "utf8"),
  chinese: await readFile(
    path.join(repositoryRoot, "README.zh-CN.md"),
    "utf8",
  ),
};

const headingPairs = [
  ["##", "Desktop preview", "桌面界面"],
  ["##", "What is included", "已实现"],
  ["##", "Architecture", "架构"],
  ["##", "Requirements", "环境要求"],
  ["##", "Run locally", "本地运行"],
  ["##", "Model providers", "模型提供商"],
  ["##", "Safety model", "安全模型"],
  ["##", "Verify", "验证"],
  ["##", "Project layout", "项目结构"],
  ["##", "Contributing and license", "贡献与许可"],
];

const capabilityPairs = [
  ["Desktop shell", "桌面外壳"],
  ["Agent runtime", "Agent 运行时"],
  ["Coding tools", "编码工具"],
  ["Local persistence", "本地持久化"],
  ["Approvals", "审批"],
  ["Worktree isolation", "Worktree 隔离"],
  ["Local preview", "本地预览"],
  ["Model providers", "模型提供商"],
  ["Delivery", "交付"],
];

const failures = [];
const expectedBadges = [
  "[![CI](https://github.com/Whiskeyi/brace/actions/workflows/ci.yml/badge.svg)](https://github.com/Whiskeyi/brace/actions/workflows/ci.yml)",
  "[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)",
  "[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=nodedotjs&logoColor=white)](package.json)",
];

function extractHeadings(markdown) {
  return [...markdown.matchAll(/^(#{2,3}) (.+)$/gm)].map(
    ([, level, title]) => ({ level, title }),
  );
}

function extractFencedBlocks(markdown) {
  return [...markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```$/gm)].map(
    ([, language, body]) => ({ language, body }),
  );
}

function extractInlineCode(markdown) {
  const withoutFences = markdown.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "");
  return [...withoutFences.matchAll(/`([^`\n]+)`/g)]
    .map(([, token]) => token)
    .sort();
}

function extractBadges(markdown) {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("[!["));
}

function readCapabilityNames(markdown, heading) {
  const sectionStart = markdown.indexOf(`## ${heading}`);
  if (sectionStart < 0) {
    return [];
  }

  const rows = markdown.slice(sectionStart).split("\n");
  const firstTableRow = rows.findIndex((line) => line.startsWith("|"));
  if (firstTableRow < 0) {
    return [];
  }

  const capabilities = [];
  for (const line of rows.slice(firstTableRow + 2)) {
    if (!line.startsWith("|")) {
      break;
    }
    const name = line.split("|")[1]?.trim();
    if (name) {
      capabilities.push(name);
    }
  }
  return capabilities;
}

function reportMismatch(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${label} mismatch.\nExpected: ${JSON.stringify(expected, null, 2)}\nActual: ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

if (
  !documents.english.includes(
    "**English** | [简体中文](README.zh-CN.md)",
  )
) {
  failures.push(
    "README.md must identify English as the default and link to README.zh-CN.md.",
  );
}

if (!documents.chinese.includes("[English](README.md) | **简体中文**")) {
  failures.push(
    "README.zh-CN.md must link back to the default English README.md.",
  );
}

const englishHeadings = extractHeadings(documents.english);
const chineseHeadings = extractHeadings(documents.chinese);
reportMismatch(
  "English README heading structure",
  englishHeadings,
  headingPairs.map(([level, english]) => ({ level, title: english })),
);
reportMismatch(
  "Chinese README heading structure",
  chineseHeadings,
  headingPairs.map(([level, , chinese]) => ({ level, title: chinese })),
);

reportMismatch(
  "Fenced code and command blocks",
  extractFencedBlocks(documents.chinese),
  extractFencedBlocks(documents.english),
);

reportMismatch(
  "Inline code identifiers",
  extractInlineCode(documents.chinese),
  extractInlineCode(documents.english),
);
reportMismatch(
  "English README badges",
  extractBadges(documents.english),
  expectedBadges,
);
reportMismatch(
  "Chinese README badges",
  extractBadges(documents.chinese),
  expectedBadges,
);

reportMismatch(
  "Implemented capability rows",
  readCapabilityNames(documents.english, "What is included").map(
    (english, index) => [
      english,
      readCapabilityNames(documents.chinese, "已实现")[index],
    ],
  ),
  capabilityPairs,
);

if (failures.length > 0) {
  process.stderr.write(
    `README parity check failed:\n\n${failures.join("\n\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("README English/Chinese parity check passed.\n");
}

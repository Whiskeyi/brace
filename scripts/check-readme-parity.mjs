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
  ["##", "What is implemented", "已实现的功能"],
  ["##", "Architecture at a glance", "架构概览"],
  ["##", "Prerequisites", "前置条件"],
  ["##", "Run the desktop client", "运行桌面客户端"],
  [
    "###",
    "Model providers, plans, and connection testing",
    "模型提供商、计划与连接测试",
  ],
  ["###", "Preview a local Web application", "预览本地 Web 应用"],
  ["##", "Run the web application", "运行网页应用"],
  ["###", "Runtime limits", "运行时限制"],
  ["###", "Optional integrations", "可选集成"],
  ["##", "Use the headless coding agent", "使用无界面编码智能体"],
  ["##", "Durable web-run lifecycle", "持久化网页运行生命周期"],
  ["##", "Health and deployment", "健康检查与部署"],
  ["##", "Verify", "验证"],
  ["##", "Project layout", "项目布局"],
  ["##", "Security boundary and known limits", "安全边界与已知限制"],
  ["##", "Official references", "官方参考"],
  ["##", "Contributing, security, and license", "贡献、安全与许可"],
];

const capabilityPairs = [
  ["Agent core", "智能体核心"],
  ["Model adapters", "模型适配器"],
  ["Coding workspace", "编码工作区"],
  ["Controlled execution", "受控执行"],
  ["Tool authorization", "工具授权"],
  ["Event protocol", "事件协议"],
  ["Desktop client", "桌面客户端"],
  ["Local durability", "本地持久化"],
  ["Worktree isolation", "Worktree 隔离"],
  ["Durable runs", "持久化运行"],
  ["Context", "上下文"],
  ["Identity and isolation", "身份与隔离"],
  ["Optional data tools", "可选数据工具"],
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
  readCapabilityNames(documents.english, "What is implemented").map(
    (english, index) => [
      english,
      readCapabilityNames(documents.chinese, "已实现的功能")[index],
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

const { Client } = require("@notionhq/client");
const { NotionToMarkdown } = require("notion-to-md");
const moment = require("moment");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

// Notion 클라이언트를 초기화합니다.
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

// 코드 블록을 이스케이프하는 함수입니다.
function escapeCodeBlock(body) {
  const regex = /```([\s\S]*?)```/g;
  return body.replace(regex, function (match, htmlBlock) {
    return "\n{% raw %}\n```" + htmlBlock.trim() + "\n```\n{% endraw %}\n";
  });
}

// Raw 블록 외부의 제목을 바꾸는 함수입니다.
function replaceTitleOutsideRawBlocks(body) {
  const rawBlocks = [];
  const placeholder = "%%RAW_BLOCK%%";
  body = body.replace(/{% raw %}[\s\S]*?{% endraw %}/g, (match) => {
    rawBlocks.push(match);
    return placeholder;
  });

  const regex = /\n#[^\n]+\n/g;
  body = body.replace(regex, function (match) {
    return "\n" + match.replace("\n#", "\n##");
  });

  rawBlocks.forEach(block => {
    body = body.replace(placeholder, block);
  });

  return body;
}
// 목록 항목 앞에 공백을 추가하여 들여쓰기를 일관되게 유지
function processMarkdown(body) {
  body = body.replace(/^> /gm, '');
  body = body.replace(/^- /gm, '  - ');
  return body;
}

// `<aside>` 태그를 변환 중에 유지하도록 추가한 함수
function preserveAsideTag(body) {
  return body.replace(/<aside>/g, '\n<aside>\n').replace(/<\/aside>/g, '\n</aside>\n');
}

// Notion 클라이언트를 옵션으로 전달합니다.
const n2m = new NotionToMarkdown({ notionClient: notion });

(async () => {
  // 디렉토리가 존재하는지 확인합니다.
  const root = "_posts";
  fs.mkdirSync(root, { recursive: true });

  const databaseId = process.env.DATABASE_ID;
  let response = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: "공개",
      checkbox: {
        equals: true,
      },
    },
  });

  const pages = response.results;
  while (response.has_more) {
    const nextCursor = response.next_cursor;
    response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: nextCursor,
      filter: {
        property: "공개",
        checkbox: {
          equals: true,
        },
      },
    });
    pages.push(...response.results);
  }

  for (const r of pages) {
    const id = r.id;
    // 날짜 처리
    let date = moment(r.created_time).format("YYYY-MM-DD");
    let pdate = r.properties?.["날짜"]?.["date"]?.["start"];
    if (pdate) {
      date = moment(pdate).format("YYYY-MM-DD");
    }
    // 제목 처리
    let title = id;
    let ptitle = r.properties?.["게시물"]?.["title"];
    if (ptitle?.length > 0) {
      title = ptitle[0]?.["plain_text"];
    }
    // 태그 처리
    let tags = [];
    let ptags = r.properties?.["태그"]?.["multi_select"];
    for (const t of ptags) {
      const n = t?.["name"];
      if (n) {
        tags.push(n);
      }
    }
    // 카테고리 처리
    let cats = [];
    let pcats = r.properties?.["카테고리"]?.["multi_select"];
    for (const t of pcats) {
      const n = t?.["name"];
      if (n) {
        cats.push(n);
      }
    }

    // Frontmatter 생성
    let fmtags = "";
    let fmcats = "";
    if (tags.length > 0) {
      fmtags += "\ntags: [";
      for (const t of tags) {
        fmtags += t + ", ";
      }
      fmtags += "]";
    }
    if (cats.length > 0) {
      fmcats += "\ncategories: [";
      for (const t of cats) {
        fmcats += t + ", ";
      }
      fmcats += "]";
    }
    const fm = `---
layout: post
date: ${date}
title: "${title}"${fmtags}${fmcats}
---
`;

    // 마크다운 변환
    const mdblocks = await n2m.pageToMarkdown(id);
    let md = n2m.toMarkdownString(mdblocks)["parent"];
    if (md === "") {
      continue;
    }
    md = escapeCodeBlock(md);
    md = replaceTitleOutsideRawBlocks(md);
    md = preserveAsideTag(md); // 추가된 부분
    md = processMarkdown(md); // 추가된 부분

    const ftitle = `${date}-${title.replaceAll(" ", "-")}.md`;

    let index = 0;
    let edited_md = md.replace(
      /!\[(.*?)\]\((.*?)\)/g,
      function (match, p1, p2, p3) {
        const dirname = path.join("assets/img", ftitle);
        if (!fs.existsSync(dirname)) {
          fs.mkdirSync(dirname, { recursive: true });
        }
        const filename = path.join(dirname, `${index}.png`);

        axios({
          method: "get",
          url: p2,
          responseType: "stream",
        })
          .then(function (response) {
            let file = fs.createWriteStream(`${filename}`);
            response.data.pipe(file);
          })
          .catch(function (error) {
            console.log(error);
          });

        let res;
        if (p1 === "") res = "";
        else res = `_${p1}_`;

        return `![${index++}](/${filename})${res}`;
      }
    );

    // 파일에 쓰기
    fs.writeFile(path.join(root, ftitle), fm + edited_md, (err) => {
      if (err) {
        console.log(err);
      }
    });
  }
})();

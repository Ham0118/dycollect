import { describe, expect, it } from "vitest";
import { markdownToFeishu } from "./feishu-markdown.js";

describe("markdownToFeishu", () => {
  it("uses the first H1 as the document title and preserves common rich text", () => {
    const result = markdownToFeishu(`# 示例文章

- 作者：测试作者
- 原视频：[打开作品](https://www.douyin.com/video/12345678)

## 转录正文

这是 **粗体**、*斜体* 和 \`代码\`。

> 一段引用
`);

    expect(result.title).toBe("示例文章");
    expect(result.blocks.map((block) => block.block_type)).toEqual([12, 12, 4, 2, 15]);
    const serialized = JSON.stringify(result.blocks);
    expect(serialized).toContain('"bold":true');
    expect(serialized).toContain('"italic":true');
    expect(serialized).toContain('"inline_code":true');
    expect(serialized).toContain("https://www.douyin.com/video/12345678");
    expect(serialized).not.toContain('"heading1"');
  });

  it("splits oversized paragraphs into safe block sizes", () => {
    const result = markdownToFeishu(`长文\n\n${"字".repeat(9_001)}`);
    expect(result.blocks).toHaveLength(4);
    const sizes = result.blocks.slice(1).map((block) => {
      const text = block.text as { elements: Array<{ text_run: { content: string } }> };
      return text.elements.reduce((total, element) => total + element.text_run.content.length, 0);
    });
    expect(sizes).toEqual([4_000, 4_000, 1_001]);
  });

  it("degrades images and tables into readable text", () => {
    const result = markdownToFeishu("![流程图](https://example.com/image.png)\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    const serialized = JSON.stringify(result.blocks);
    expect(serialized).toContain("流程图（https://example.com/image.png）");
    expect(serialized).toContain("A | B");
    expect(serialized).toContain("1 | 2");
  });
});

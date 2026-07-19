import { describe, it, expect } from "vitest";
import {
  generateLayout,
  generateLayoutTree,
  resolveWidgetClass,
  slotTypeForParent,
  type WidgetNode,
} from "../../src/templates/layout.js";
import { parse } from "../../src/formats/enfusion-text.js";

describe("resolveWidgetClass", () => {
  it("maps friendly aliases to *WidgetClass", () => {
    expect(resolveWidgetClass("Frame")).toBe("FrameWidgetClass");
    expect(resolveWidgetClass("VerticalLayout")).toBe("VerticalLayoutWidgetClass");
    expect(resolveWidgetClass("RichText")).toBe("RichTextWidgetClass");
    expect(resolveWidgetClass("ProgressBar")).toBe("ProgressBarWidgetClass");
  });

  it("passes raw class names through unchanged", () => {
    expect(resolveWidgetClass("ImageWidgetClass")).toBe("ImageWidgetClass");
    expect(resolveWidgetClass("SCR_CustomWidgetClass")).toBe("SCR_CustomWidgetClass");
  });
});

describe("slotTypeForParent", () => {
  it("infers slot type from the parent widget class", () => {
    expect(slotTypeForParent("FrameWidgetClass")).toBe("FrameWidgetSlot");
    expect(slotTypeForParent("VerticalLayoutWidgetClass")).toBe("LayoutSlot");
    expect(slotTypeForParent("HorizontalLayoutWidgetClass")).toBe("LayoutSlot");
    expect(slotTypeForParent("OverlayWidgetClass")).toBe("OverlayWidgetSlot");
    expect(slotTypeForParent("ScaleWidgetClass")).toBe("AlignableSlot");
  });

  it("defaults unknown parents to LayoutSlot", () => {
    expect(slotTypeForParent("SomethingWidgetClass")).toBe("LayoutSlot");
  });
});

describe("generateLayoutTree", () => {
  const tree: WidgetNode = {
    type: "Frame",
    name: "rootFrame",
    children: [
      {
        type: "Overlay",
        name: "Overlay0",
        slot: { anchor: "1 0.5 1 0.5", offsetLeft: -60, offsetTop: 300 },
        children: [
          {
            type: "Image",
            name: "Icon",
            slot: { horizontalAlign: 3, verticalAlign: 3 },
            props: { Opacity: "0", Texture: "{ABC}Images/Icon.edds", "Blend Mode": "Additive" },
          },
        ],
      },
      {
        type: "VerticalLayout",
        name: "Stack",
        slot: { anchor: "0.5 0 0.5 0" },
        children: [
          {
            type: "RichText",
            name: "Timer",
            slot: { padding: "5 0 5 0" },
            props: { Text: "01:00", "Font Size": "36" },
            font: { font: "{EAB}UI/Fonts/RobotoCondensed/RobotoCondensed_Bold.fnt", shadowSize: 5 },
          },
        ],
      },
    ],
  };

  const out = generateLayoutTree(tree);

  it("never emits a Children keyword (uses anonymous blocks)", () => {
    expect(out).not.toMatch(/\bChildren\b/);
  });

  it("emits an anonymous child block", () => {
    // A brace block opened by whitespace only (no type name before it).
    expect(out).toMatch(/\n\s+\{/);
  });

  it("resolves aliases to widget classes", () => {
    expect(out).toContain("FrameWidgetClass {");
    expect(out).toContain("OverlayWidgetClass");
    expect(out).toContain("VerticalLayoutWidgetClass");
    expect(out).toContain("RichTextWidgetClass");
    expect(out).toContain("ImageWidgetClass");
  });

  it("gives each child the slot type inferred from its parent", () => {
    // Overlay + VerticalLayout are children of the root Frame -> FrameWidgetSlot
    expect(out).toContain("Slot FrameWidgetSlot");
    // Image is a child of Overlay -> OverlayWidgetSlot
    expect(out).toContain("Slot OverlayWidgetSlot");
    // Timer is a child of VerticalLayout -> LayoutSlot
    expect(out).toContain("Slot LayoutSlot");
  });

  it("does not emit a slot on the root widget", () => {
    const firstLines = out.split("\n").slice(0, 3).join("\n");
    expect(firstLines).toContain("FrameWidgetClass {");
    expect(firstLines).not.toContain("Slot");
  });

  it("expands font into a FontProperties sub-node", () => {
    expect(out).toContain('FontProperties FontProperties "{');
    expect(out).toContain("RobotoCondensed_Bold.fnt");
    expect(out).toContain("ShadowSize 5");
  });

  it("emits numeric tuple slot values unquoted", () => {
    expect(out).toContain("Anchor 1 0.5 1 0.5");
    expect(out).not.toContain('Anchor "1 0.5 1 0.5"');
  });

  it("quotes multi-word property keys but keeps enum values bare", () => {
    // Enum-valued keys are written as bare tokens, matching the engine's own
    // serialization in shipped .layout files.
    expect(out).toContain('"Blend Mode" Additive');
    expect(out).not.toContain('"Blend Mode" "Additive"');
  });

  it("quotes string-valued properties", () => {
    expect(out).toContain('Texture "{ABC}Images/Icon.edds"');
  });

  it("parses back without throwing (valid Enfusion text)", () => {
    expect(() => parse(out)).not.toThrow();
  });
});

describe("generateLayout (flat back-compat API)", () => {
  for (const layoutType of ["hud", "menu", "dialog", "list", "custom"] as const) {
    it(`generates a ${layoutType} layout without the Children bug`, () => {
      const out = generateLayout({ name: "Test", layoutType });
      expect(out).toContain("FrameWidgetClass {");
      expect(out).not.toMatch(/\bChildren\b/);
      expect(() => parse(out)).not.toThrow();
    });
  }

  it("positions the panel with a FrameWidgetSlot and omits a root slot", () => {
    const out = generateLayout({ name: "Test", layoutType: "hud" });
    expect(out).toContain("Slot FrameWidgetSlot");
    // Root frame line has no slot immediately after it.
    expect(out.split("\n")[0]).toBe("FrameWidgetClass {");
  });

  it("carries user widgets and their properties through", () => {
    const out = generateLayout({
      name: "Test",
      layoutType: "custom",
      widgets: [
        { type: "TextWidgetClass", name: "Score", anchor: "0 0 1 0", properties: { Text: "0" } },
      ],
    });
    expect(out).toContain('Name "Score"');
    // Text is a string field — quoted even when the value looks numeric.
    expect(out).toContain('Text "0"');
  });
});

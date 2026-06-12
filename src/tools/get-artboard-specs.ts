import { fetchXDFile } from '../utils/fetch-xd';
import {
  XDParser,
  colorToHex,
  colorToRGBA,
  shadowToCSS,
  borderRadiusToCSS,
} from '../parser/xd-parser';
import {
  XDArtboard,
  XDElement,
  ArtboardSpecs,
  ColorSpec,
  TypographySpec,
  SpacingSpec,
  BorderSpec,
  ShadowSpec,
  ElementSpec,
} from '../parser/types';

export interface GetArtboardSpecsInput {
  xd_source: string;
  artboard_name: string;
}

export async function getArtboardSpecs(input: GetArtboardSpecsInput): Promise<string> {
  const { xd_source, artboard_name } = input;

  const buffer = await fetchXDFile(xd_source);
  const parser = new XDParser(buffer);
  const artboard = parser.getArtboard(artboard_name);

  if (!artboard) {
    const all = parser.listArtboards().map((a) => `  - ${a.name}`).join('\n');
    return `Artboard "${artboard_name}" not found.\n\nAvailable artboards:\n${all}`;
  }

  const specs = buildSpecs(artboard);
  return formatSpecs(specs);
}

function buildSpecs(artboard: XDArtboard): ArtboardSpecs {
  const colors: ColorSpec[] = [];
  const typography: TypographySpec[] = [];
  const spacing: SpacingSpec[] = [];
  const borders: BorderSpec[] = [];
  const shadows: ShadowSpec[] = [];
  const elements: ElementSpec[] = [];

  collectFromElements(artboard.children, colors, typography, spacing, borders, shadows, elements);

  // Deduplicate colors by hex+role
  const seenColors = new Set<string>();
  const uniqueColors = colors.filter((c) => {
    const key = `${c.hex}-${c.role}-${c.elementName}`;
    if (seenColors.has(key)) return false;
    seenColors.add(key);
    return true;
  });

  return {
    name: artboard.name,
    dimensions: { width: artboard.width, height: artboard.height },
    colors: uniqueColors,
    typography,
    spacing,
    borders,
    shadows,
    elements,
  };
}

function collectFromElements(
  elements: XDElement[],
  colors: ColorSpec[],
  typography: TypographySpec[],
  spacing: SpacingSpec[],
  borders: BorderSpec[],
  shadows: ShadowSpec[],
  elementSpecs: ElementSpec[]
): void {
  for (const el of elements) {
    if (!el.visible) continue;

    const elSpec: ElementSpec = {
      name: el.name,
      type: el.type,
      dimensions: { width: Math.round(el.width), height: Math.round(el.height) },
      position: { x: Math.round(el.x), y: Math.round(el.y) },
      fills: [],
      opacity: el.opacity ?? 1,
    };

    // Border radius
    if (el.borderRadius !== undefined) {
      elSpec.borderRadius = borderRadiusToCSS(el.borderRadius);
    }

    // Fills → colors
    for (const fill of el.fills || []) {
      if (fill.type === 'solid' && fill.color) {
        const hex = colorToHex(fill.color);
        const rgba = colorToRGBA(fill.color);
        colors.push({ elementName: el.name, role: 'fill', hex, rgba, opacity: fill.color.a ?? 1 });
        elSpec.fills.push(hex);
      } else if (fill.type === 'gradient' && fill.gradient) {
        const stops = fill.gradient.stops
          .map((s) => `${colorToHex(s.color)} ${Math.round(s.position * 100)}%`)
          .join(', ');
        const css =
          fill.gradient.type === 'radial'
            ? `radial-gradient(${stops})`
            : `linear-gradient(${stops})`;
        elSpec.fills.push(css);
      }
    }

    // Strokes → borders + colors
    for (const stroke of el.strokes || []) {
      const hex = colorToHex(stroke.color);
      colors.push({
        elementName: el.name,
        role: 'stroke',
        hex,
        rgba: colorToRGBA(stroke.color),
        opacity: stroke.color.a ?? 1,
      });
      borders.push({
        elementName: el.name,
        color: hex,
        width: stroke.width,
        position: stroke.position,
        borderRadius: elSpec.borderRadius,
      });
    }

    // Shadows
    for (const shadow of el.shadows || []) {
      const css = shadowToCSS(shadow);
      shadows.push({ elementName: el.name, cssValue: css });
    }

    // Typography
    if (el.textStyle) {
      const ts = el.textStyle;
      const entry: TypographySpec = {
        elementName: el.name,
        fontFamily: ts.fontFamily,
        fontSize: ts.fontSize,
        fontWeight: ts.fontWeight,
        lineHeight: ts.lineHeight,
        letterSpacing: ts.letterSpacing,
        textAlign: ts.textAlign,
        textTransform: ts.textTransform,
      };
      if (ts.color) {
        const hex = colorToHex(ts.color);
        entry.color = hex;
        colors.push({
          elementName: el.name,
          role: 'text',
          hex,
          rgba: colorToRGBA(ts.color),
          opacity: ts.color.a ?? 1,
        });
      }
      typography.push(entry);
    }

    // Spacing
    spacing.push({
      elementName: el.name,
      x: Math.round(el.x),
      y: Math.round(el.y),
      width: Math.round(el.width),
      height: Math.round(el.height),
      paddingTop: el.paddingTop,
      paddingRight: el.paddingRight,
      paddingBottom: el.paddingBottom,
      paddingLeft: el.paddingLeft,
    });

    elementSpecs.push(elSpec);

    // Recurse
    if (el.children?.length) {
      collectFromElements(el.children, colors, typography, spacing, borders, shadows, elementSpecs);
    }
  }
}

function truncate(name: string, max = 40): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

function formatSpecs(specs: ArtboardSpecs): string {
  const lines: string[] = [];

  lines.push(`# Artboard Specs: ${specs.name}`);
  lines.push(`Dimensions: ${specs.dimensions.width}px × ${specs.dimensions.height}px`);
  lines.push('');

  // ── Colors ──────────────────────────────────────────────────────────────
  // Aggregate to a unique palette per role (a board can repeat one colour
  // across hundreds of elements; list each value once with a usage count).
  lines.push('## Colors');
  if (specs.colors.length === 0) {
    lines.push('None found.');
  } else {
    const palette = (role: ColorSpec['role']) => {
      const agg = new Map<string, { hex: string; rgba: string; opacity: number; count: number }>();
      for (const c of specs.colors) {
        if (c.role !== role) continue;
        const cur = agg.get(c.hex);
        if (cur) cur.count++;
        else agg.set(c.hex, { hex: c.hex, rgba: c.rgba, opacity: c.opacity, count: 1 });
      }
      return [...agg.values()].sort((a, b) => b.count - a.count);
    };
    const section = (title: string, role: ColorSpec['role']) => {
      const colors = palette(role);
      if (!colors.length) return;
      lines.push(`### ${title}`);
      for (const c of colors) {
        const opStr = c.opacity < 1 ? ` (opacity: ${c.opacity.toFixed(2)})` : '';
        lines.push(`  ${c.hex} / ${c.rgba}${opStr}  ×${c.count}`);
      }
    };
    section('Fill Colors', 'fill');
    section('Text Colors', 'text');
    section('Stroke/Border Colors', 'stroke');
  }
  lines.push('');

  // ── Typography ──────────────────────────────────────────────────────────
  // Collapse to the unique type scale — identical styles repeat across many
  // text nodes, so key by the full style signature and count occurrences.
  lines.push('## Typography');
  if (specs.typography.length === 0) {
    lines.push('None found.');
  } else {
    const agg = new Map<string, { t: TypographySpec; count: number }>();
    for (const t of specs.typography) {
      const sig = [
        t.fontFamily, t.fontSize, t.fontWeight, t.lineHeight,
        t.letterSpacing, t.textAlign, t.textTransform, t.color,
      ].join('|');
      const cur = agg.get(sig);
      if (cur) cur.count++;
      else agg.set(sig, { t, count: 1 });
    }
    const styles = [...agg.values()].sort(
      (a, b) => (b.t.fontSize || 0) - (a.t.fontSize || 0)
    );
    for (const { t, count } of styles) {
      lines.push(`### ${t.fontFamily} ${t.fontSize}px / ${t.fontWeight}  ×${count}`);
      if (t.lineHeight) lines.push(`  line-height: ${t.lineHeight}px`);
      if (t.letterSpacing !== undefined) lines.push(`  letter-spacing: ${t.letterSpacing}em`);
      if (t.textAlign) lines.push(`  text-align: ${t.textAlign}`);
      if (t.textTransform) lines.push(`  text-transform: ${t.textTransform}`);
      if (t.color) lines.push(`  color: ${t.color}`);
    }
  }
  lines.push('');

  // ── Borders ──────────────────────────────────────────────────────────────
  // Dedupe identical border definitions (width + colour + position + radius).
  lines.push('## Borders & Border Radius');
  const borderAgg = new Map<string, { b: BorderSpec; count: number }>();
  for (const b of specs.borders) {
    const sig = `${b.width}|${b.color}|${b.position}|${b.borderRadius ?? ''}`;
    const cur = borderAgg.get(sig);
    if (cur) cur.count++;
    else borderAgg.set(sig, { b, count: 1 });
  }
  // Unique border-radius values on non-bordered elements.
  const radii = new Map<string, number>();
  for (const e of specs.elements) {
    if (e.borderRadius && !specs.borders.find((b) => b.borderRadius === e.borderRadius)) {
      radii.set(e.borderRadius, (radii.get(e.borderRadius) ?? 0) + 1);
    }
  }
  if (borderAgg.size === 0 && radii.size === 0) {
    lines.push('None found.');
  } else {
    for (const { b, count } of borderAgg.values()) {
      const radius = b.borderRadius ? `, radius ${b.borderRadius}` : '';
      lines.push(`  ${b.width}px ${b.color} (${b.position})${radius}  ×${count}`);
    }
    for (const [r, count] of radii) {
      lines.push(`  border-radius: ${r}  ×${count}`);
    }
  }
  lines.push('');

  // ── Shadows ──────────────────────────────────────────────────────────────
  lines.push('## Shadows');
  if (specs.shadows.length === 0) {
    lines.push('None found.');
  } else {
    for (const s of specs.shadows) {
      lines.push(`  ${s.elementName}: box-shadow: ${s.cssValue}`);
    }
  }
  lines.push('');

  // ── Vertical Spacing between text blocks ─────────────────────────────────
  lines.push('## Vertical Spacing (gaps between text blocks, top→bottom)');
  const textNames = new Set(specs.typography.map((t) => t.elementName));
  const textBoxes = specs.spacing
    .filter((s) => textNames.has(s.elementName) && s.height > 0)
    .sort((a, b) => a.y - b.y);
  if (textBoxes.length < 2) {
    lines.push('Not enough text blocks to measure.');
  } else {
    for (let i = 1; i < textBoxes.length; i++) {
      const prev = textBoxes[i - 1];
      const cur = textBoxes[i];
      const gap = Math.round(cur.y - (prev.y + prev.height));
      lines.push(
        `  ${gap}px  between "${truncate(prev.elementName)}" (y=${prev.y}) and "${truncate(cur.elementName)}" (y=${cur.y})`
      );
    }
  }
  lines.push('');

  // ── Layout & Spacing ─────────────────────────────────────────────────────
  // Only named, sized elements — skip the thousands of "unnamed" vector nodes
  // and zero-size placeholders that would otherwise bury the useful structure.
  lines.push('## Layout & Spacing');
  lines.push('Named elements with a size (absolute to artboard):');
  const LAYOUT_CAP = 150;
  const layout = specs.spacing.filter(
    (s) => s.elementName !== 'unnamed' && (s.width > 0 || s.height > 0)
  );
  for (const s of layout.slice(0, LAYOUT_CAP)) {
    lines.push(`  ${truncate(s.elementName)}: x=${s.x}px, y=${s.y}px, w=${s.width}px, h=${s.height}px`);
    if (s.paddingTop !== undefined) {
      lines.push(
        `    padding: ${s.paddingTop}px ${s.paddingRight ?? 0}px ${s.paddingBottom ?? 0}px ${s.paddingLeft ?? 0}px`
      );
    }
  }
  if (layout.length > LAYOUT_CAP) {
    lines.push(`  … ${layout.length - LAYOUT_CAP} more named elements omitted.`);
  }
  const hidden = specs.spacing.length - layout.length;
  if (hidden > 0) {
    lines.push(`(${hidden} unnamed/zero-size nodes hidden.)`);
  }
  lines.push('');

  // ── SCSS Snippet ─────────────────────────────────────────────────────────
  lines.push('## Suggested SCSS Variables');
  lines.push('```scss');
  lines.push(`// ${specs.name} - extracted from XD`);

  const seenColors = new Set<string>();
  let colorIndex = 1;
  for (const c of specs.colors) {
    if (!seenColors.has(c.hex)) {
      seenColors.add(c.hex);
      lines.push(`$color-${colorIndex++}: ${c.hex};`);
    }
  }

  // One variable per unique font size (the type scale), not per text node.
  const sizes = new Map<number, TypographySpec>();
  for (const t of specs.typography) {
    if (!sizes.has(t.fontSize)) sizes.set(t.fontSize, t);
  }
  for (const t of [...sizes.values()].sort((a, b) => b.fontSize - a.fontSize)) {
    const safe = `${t.fontSize}`;
    lines.push(`$font-size-${safe}: ${t.fontSize}px; // ${t.fontFamily} ${t.fontWeight}`);
    if (t.lineHeight) lines.push(`$line-height-${safe}: ${t.lineHeight}px;`);
  }

  const seenShadows = new Set<string>();
  let shadowIndex = 1;
  for (const s of specs.shadows) {
    if (seenShadows.has(s.cssValue)) continue;
    seenShadows.add(s.cssValue);
    lines.push(`$shadow-${shadowIndex++}: ${s.cssValue};`);
  }

  lines.push('```');

  return lines.join('\n');
}

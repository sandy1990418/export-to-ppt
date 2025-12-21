import { ElementHandle, Page } from "puppeteer";
import { ElementAttributes, SlideAttributesResult } from "@/types/element_attibutes";

interface BatchExtractResult {
  elements: Array<ElementAttributes & {
    _elementPath?: string;  // CSS path for elements that need screenshot
    _depth: number;
  }>;
  backgroundColor?: string;
  screenshotElements: string[];  // CSS paths for elements needing screenshots
}

/**
 * Extract all element attributes from a slide in a single evaluate call.
 * This is much faster than calling evaluate() for each element individually.
 */
export async function extractSlideAttributesBatch(
  slideElement: ElementHandle<Element>,
  rootRect?: { left: number; top: number; width: number; height: number }
): Promise<BatchExtractResult> {
  const result = await slideElement.evaluate((slideEl, initialRootRect) => {
    // ============= Helper Functions (same as original) =============

    function colorToHex(color: string): { hex: string | undefined; opacity: number | undefined } {
      if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") {
        return { hex: undefined, opacity: undefined };
      }

      if (color.startsWith("rgba(") || color.startsWith("hsla(")) {
        const match = color.match(/rgba?\(([^)]+)\)|hsla?\(([^)]+)\)/);
        if (match) {
          const values = match[1] || match[2];
          const parts = values.split(",").map((part) => part.trim());
          if (parts.length >= 4) {
            const opacity = parseFloat(parts[3]);
            const rgbColor = color.replace(/rgba?\(|hsla?\(|\)/g, "").split(",").slice(0, 3).join(",");
            const rgbString = color.startsWith("rgba") ? `rgb(${rgbColor})` : `hsl(${rgbColor})`;
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.fillStyle = rgbString;
              const hexColor = ctx.fillStyle;
              const hex = hexColor.startsWith("#") ? hexColor.substring(1) : hexColor;
              return { hex, opacity: isNaN(opacity) ? undefined : opacity };
            }
          }
        }
      }

      if (color.startsWith("rgb(") || color.startsWith("hsl(")) {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = color;
          const hexColor = ctx.fillStyle;
          const hex = hexColor.startsWith("#") ? hexColor.substring(1) : hexColor;
          return { hex, opacity: undefined };
        }
      }

      if (color.startsWith("#")) {
        return { hex: color.substring(1), opacity: undefined };
      }

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return { hex: color, opacity: undefined };
      ctx.fillStyle = color;
      const hexColor = ctx.fillStyle;
      return { hex: hexColor.startsWith("#") ? hexColor.substring(1) : hexColor, opacity: undefined };
    }

    function hasOnlyTextNodes(el: Element): boolean {
      for (let i = 0; i < el.childNodes.length; i++) {
        if (el.childNodes[i].nodeType === Node.ELEMENT_NODE) return false;
      }
      return true;
    }

    function parsePosition(el: Element) {
      const rect = el.getBoundingClientRect();
      return {
        left: isFinite(rect.left) ? rect.left : 0,
        top: isFinite(rect.top) ? rect.top : 0,
        width: isFinite(rect.width) ? rect.width : 0,
        height: isFinite(rect.height) ? rect.height : 0,
      };
    }

    function parseBackground(computedStyles: CSSStyleDeclaration) {
      const result = colorToHex(computedStyles.backgroundColor);
      if (!result.hex && result.opacity === undefined) return undefined;
      return { color: result.hex, opacity: result.opacity };
    }

    function parseBackgroundImage(computedStyles: CSSStyleDeclaration) {
      const bgImage = computedStyles.backgroundImage;
      if (!bgImage || bgImage === "none") return undefined;
      const match = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
      return match?.[1];
    }

    function parseBorder(computedStyles: CSSStyleDeclaration) {
      const colorResult = colorToHex(computedStyles.borderColor);
      const width = parseFloat(computedStyles.borderWidth);
      if (width === 0) return undefined;
      if (!colorResult.hex && isNaN(width) && colorResult.opacity === undefined) return undefined;
      return { color: colorResult.hex, width: isNaN(width) ? undefined : width, opacity: colorResult.opacity };
    }

    function parseShadow(computedStyles: CSSStyleDeclaration) {
      const boxShadow = computedStyles.boxShadow;
      if (!boxShadow || boxShadow === "none") return undefined;

      // Parse shadow (simplified version for performance)
      const shadows: string[] = [];
      let current = "", parenCount = 0;
      for (const char of boxShadow) {
        if (char === "(") parenCount++;
        else if (char === ")") parenCount--;
        else if (char === "," && parenCount === 0) {
          shadows.push(current.trim());
          current = "";
          continue;
        }
        current += char;
      }
      if (current.trim()) shadows.push(current.trim());

      // Find best shadow
      let bestShadow = shadows[0] || "";
      for (const s of shadows) {
        const parts = s.split(/\s+/).filter(p => p);
        const hasColor = parts.some(p => p.match(/^(rgba?|hsla?|#)/i));
        const hasOffset = parts.filter(p => !isNaN(parseFloat(p))).length >= 2;
        if (hasColor && hasOffset) {
          bestShadow = s;
          break;
        }
      }

      if (!bestShadow) return undefined;

      // Parse the best shadow
      const parts = bestShadow.split(/\s+/).filter(p => p);
      const numericParts: number[] = [];
      const colorParts: string[] = [];
      let isInset = false;
      let colorBuffer = "";
      let inColor = false;

      for (const part of parts) {
        if (part.toLowerCase() === "inset") { isInset = true; continue; }
        if (part.match(/^(rgba?|hsla?)\s*\(/i)) {
          inColor = true;
          colorBuffer = part;
          continue;
        }
        if (inColor) {
          colorBuffer += " " + part;
          if ((colorBuffer.match(/\(/g) || []).length <= (colorBuffer.match(/\)/g) || []).length) {
            colorParts.push(colorBuffer);
            colorBuffer = "";
            inColor = false;
          }
          continue;
        }
        const num = parseFloat(part);
        if (!isNaN(num)) numericParts.push(num);
        else colorParts.push(part);
      }

      if (numericParts.length < 2) return undefined;
      const shadowColor = colorParts.join(" ");
      const colorResult = colorToHex(shadowColor);
      if (!colorResult.hex) return undefined;

      return {
        offset: [numericParts[0], numericParts[1]] as [number, number],
        color: colorResult.hex,
        opacity: colorResult.opacity,
        radius: numericParts[2] || 0,
        spread: numericParts[3] || 0,
        inset: isInset,
        angle: Math.atan2(numericParts[1], numericParts[0]) * (180 / Math.PI),
      };
    }

    function parseFont(computedStyles: CSSStyleDeclaration) {
      const fontSize = parseFloat(computedStyles.fontSize);
      const fontWeight = parseInt(computedStyles.fontWeight);
      const colorResult = colorToHex(computedStyles.color);
      const fontFamily = computedStyles.fontFamily;
      const fontStyle = computedStyles.fontStyle;

      let fontName = undefined;
      if (fontFamily !== "initial") {
        fontName = fontFamily.split(",")[0].trim().replace(/['"]/g, "");
      }

      if (!fontName && isNaN(fontSize) && isNaN(fontWeight) && !colorResult.hex && fontStyle !== "italic") {
        return undefined;
      }

      return {
        name: fontName,
        size: isNaN(fontSize) ? undefined : fontSize,
        weight: isNaN(fontWeight) ? undefined : fontWeight,
        color: colorResult.hex,
        italic: fontStyle === "italic",
      };
    }

    function parseLineHeight(computedStyles: CSSStyleDeclaration, el: Element) {
      const lineHeight = computedStyles.lineHeight;
      const innerText = el.textContent || "";
      const htmlEl = el as HTMLElement;
      const fontSize = parseFloat(computedStyles.fontSize);
      const computed = parseFloat(lineHeight);
      const singleLine = !isNaN(computed) ? computed : fontSize * 1.2;

      const hasBreaks = /[\n\r]/.test(innerText);
      const hasWrapping = htmlEl.offsetHeight > singleLine * 2;
      const hasOverflow = htmlEl.scrollHeight > htmlEl.clientHeight;

      if ((hasBreaks || hasWrapping || hasOverflow) && lineHeight !== "normal") {
        const parsed = parseFloat(lineHeight);
        if (!isNaN(parsed)) return parsed;
      }
      return undefined;
    }

    function parseMargin(computedStyles: CSSStyleDeclaration) {
      const t = parseFloat(computedStyles.marginTop);
      const b = parseFloat(computedStyles.marginBottom);
      const l = parseFloat(computedStyles.marginLeft);
      const r = parseFloat(computedStyles.marginRight);
      if (t === 0 && b === 0 && l === 0 && r === 0) return undefined;
      return { top: isNaN(t) ? undefined : t, bottom: isNaN(b) ? undefined : b, left: isNaN(l) ? undefined : l, right: isNaN(r) ? undefined : r };
    }

    function parsePadding(computedStyles: CSSStyleDeclaration) {
      const t = parseFloat(computedStyles.paddingTop);
      const b = parseFloat(computedStyles.paddingBottom);
      const l = parseFloat(computedStyles.paddingLeft);
      const r = parseFloat(computedStyles.paddingRight);
      if (t === 0 && b === 0 && l === 0 && r === 0) return undefined;
      return { top: isNaN(t) ? undefined : t, bottom: isNaN(b) ? undefined : b, left: isNaN(l) ? undefined : l, right: isNaN(r) ? undefined : r };
    }

    function parseBorderRadius(computedStyles: CSSStyleDeclaration, el: Element) {
      const br = computedStyles.borderRadius;
      if (!br || br === "0px") return undefined;
      const parts = br.split(" ").map(p => parseFloat(p));
      let values: number[];
      if (parts.length === 1) values = [parts[0], parts[0], parts[0], parts[0]];
      else if (parts.length === 2) values = [parts[0], parts[1], parts[0], parts[1]];
      else if (parts.length === 3) values = [parts[0], parts[1], parts[2], parts[1]];
      else values = parts.slice(0, 4);

      const rect = el.getBoundingClientRect();
      const maxX = rect.width / 2, maxY = rect.height / 2;
      return values.map((r, i) => Math.max(0, Math.min(r, i === 0 || i === 2 ? maxX : maxY)));
    }

    function parseFilters(computedStyles: CSSStyleDeclaration) {
      const filter = computedStyles.filter;
      if (!filter || filter === "none") return undefined;
      const filters: Record<string, number> = {};
      const matches = filter.match(/[a-zA-Z-]+\([^)]*\)/g);
      if (matches) {
        for (const m of matches) {
          const [, type, val] = m.match(/([a-zA-Z-]+)\(([^)]*)\)/) || [];
          if (type && val) {
            const num = parseFloat(val);
            if (!isNaN(num)) {
              const key = type === "hue-rotate" ? "hueRotate" : type;
              filters[key] = num;
            }
          }
        }
      }
      return Object.keys(filters).length > 0 ? filters : undefined;
    }

    function getElementPath(el: Element, root: Element): string {
      const path: string[] = [];
      let current: Element | null = el;
      while (current && current !== root) {
        let selector = current.tagName.toLowerCase();
        if (current.id) {
          selector += `#${current.id}`;
        } else {
          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName);
            if (siblings.length > 1) {
              const index = siblings.indexOf(current) + 1;
              selector += `:nth-of-type(${index})`;
            }
          }
        }
        path.unshift(selector);
        current = current.parentElement;
      }
      return path.join(" > ");
    }

    function parseElementAttributes(el: Element, root: Element): any {
      const tagName = el.tagName.toLowerCase();
      const computedStyles = window.getComputedStyle(el);
      const position = parsePosition(el);
      const borderRadiusValue = parseBorderRadius(computedStyles, el);

      // Check for inline-only paragraph content
      let innerText: string | undefined;
      let skipChildren = false;  // Flag to skip recursion for inline-only paragraphs
      const allowedInlineTags = new Set(["strong", "u", "em", "code", "s"]);
      if (tagName === "p") {
        const innerTags = Array.from(el.querySelectorAll("*")).map(e => e.tagName.toLowerCase());
        if (innerTags.length > 0 && innerTags.every(t => allowedInlineTags.has(t))) {
          innerText = el.innerHTML;
          skipChildren = true;  // Don't recurse into inline formatting elements
        } else if (hasOnlyTextNodes(el)) {
          innerText = el.textContent || undefined;
        }
      } else {
        innerText = hasOnlyTextNodes(el) ? el.textContent || undefined : undefined;
      }

      const bgImage = parseBackgroundImage(computedStyles);
      const imageSrc = (el as HTMLImageElement).src || bgImage;
      const zIndex = parseInt(computedStyles.zIndex);
      const opacity = parseFloat(computedStyles.opacity);

      const needsScreenshot = tagName === "svg" || tagName === "canvas" || tagName === "table";

      return {
        tagName,
        id: el.id || undefined,
        className: el.className && typeof el.className === "string" ? el.className : el.className?.toString?.() || undefined,
        innerText,
        opacity: isNaN(opacity) ? undefined : opacity,
        background: parseBackground(computedStyles),
        border: parseBorder(computedStyles),
        shadow: parseShadow(computedStyles),
        font: parseFont(computedStyles),
        position,
        margin: parseMargin(computedStyles),
        padding: parsePadding(computedStyles),
        zIndex: isNaN(zIndex) ? 0 : zIndex,
        textAlign: computedStyles.textAlign !== "left" ? computedStyles.textAlign : undefined,
        lineHeight: parseLineHeight(computedStyles, el),
        borderRadius: borderRadiusValue,
        imageSrc,
        objectFit: computedStyles.objectFit !== "fill" ? computedStyles.objectFit : undefined,
        clip: false,
        overlay: undefined,
        shape: tagName === "img" && borderRadiusValue?.every((r: number) => r === 50) ? "circle" : (tagName === "img" ? "rectangle" : undefined),
        connectorType: undefined,
        textWrap: computedStyles.whiteSpace !== "nowrap",
        should_screenshot: needsScreenshot,
        filters: parseFilters(computedStyles),
        _elementPath: needsScreenshot ? getElementPath(el, root) : undefined,
        _skipChildren: skipChildren,
      };
    }

    // ============= Main Traversal Logic =============

    interface ElementResult {
      attributes: any;
      depth: number;
    }

    function traverseElement(
      el: Element,
      root: Element,
      rootRect: { left: number; top: number; width: number; height: number },
      depth: number,
      inheritedFont: any,
      inheritedBackground: any,
      inheritedBorderRadius: any,
      inheritedZIndex: number | undefined,
      inheritedOpacity: number | undefined
    ): { results: ElementResult[]; screenshotPaths: string[] } {
      const results: ElementResult[] = [];
      const screenshotPaths: string[] = [];
      const children = el.children;

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const attrs = parseElementAttributes(child, root);
        const tagName = attrs.tagName;

        // Skip non-visual elements
        if (["style", "script", "link", "meta", "path"].includes(tagName)) continue;

        // Apply inheritance
        if (inheritedFont && !attrs.font && attrs.innerText?.trim()) {
          attrs.font = inheritedFont;
        }
        if (inheritedBackground && !attrs.background && attrs.shadow) {
          attrs.background = inheritedBackground;
        }
        if (inheritedBorderRadius && !attrs.borderRadius) {
          attrs.borderRadius = inheritedBorderRadius;
        }
        if (inheritedZIndex !== undefined && attrs.zIndex === 0) {
          attrs.zIndex = inheritedZIndex;
        }
        if (inheritedOpacity !== undefined && (attrs.opacity === undefined || attrs.opacity === 1)) {
          attrs.opacity = inheritedOpacity;
        }

        // Adjust position relative to root
        if (attrs.position) {
          attrs.position = {
            left: attrs.position.left - rootRect.left,
            top: attrs.position.top - rootRect.top,
            width: attrs.position.width,
            height: attrs.position.height,
          };
        }

        // Skip zero-size elements
        if (!attrs.position || attrs.position.width === 0 || attrs.position.height === 0) continue;

        attrs._depth = depth;
        results.push({ attributes: attrs, depth });

        if (attrs.should_screenshot && attrs._elementPath) {
          screenshotPaths.push(attrs._elementPath);
        }

        // Don't recurse into canvas/table (but do recurse into svg for font inheritance)
        if (attrs.should_screenshot && tagName !== "svg") continue;

        // Don't recurse into paragraphs with only inline formatting (already captured in innerHTML)
        if (attrs._skipChildren) continue;

        // Recurse into children
        const childResults = traverseElement(
          child,
          root,
          rootRect,
          depth + 1,
          attrs.font || inheritedFont,
          attrs.background || inheritedBackground,
          attrs.borderRadius || inheritedBorderRadius,
          attrs.zIndex || inheritedZIndex,
          attrs.opacity || inheritedOpacity
        );
        results.push(...childResults.results);
        screenshotPaths.push(...childResults.screenshotPaths);
      }

      return { results, screenshotPaths };
    }

    // Get root element attributes
    const rootAttrs = parseElementAttributes(slideEl, slideEl);
    const rootRect = initialRootRect || {
      left: rootAttrs.position?.left ?? 0,
      top: rootAttrs.position?.top ?? 0,
      width: rootAttrs.position?.width ?? 1280,
      height: rootAttrs.position?.height ?? 720,
    };

    // Traverse all children
    const { results, screenshotPaths } = traverseElement(
      slideEl,
      slideEl,
      rootRect,
      0,
      rootAttrs.font,
      rootAttrs.background,
      rootAttrs.borderRadius,
      rootAttrs.zIndex,
      rootAttrs.opacity
    );

    // Find background color from root-positioned elements
    let backgroundColor = rootAttrs.background?.color;
    for (const { attributes } of results) {
      if (
        attributes.position?.left === 0 &&
        attributes.position?.top === 0 &&
        attributes.position?.width === rootRect.width &&
        attributes.position?.height === rootRect.height &&
        attributes.background?.color
      ) {
        backgroundColor = attributes.background.color;
        break;
      }
    }

    // Filter and sort elements (same logic as original)
    const filtered = results.filter(({ attributes }) => {
      const hasBackground = attributes.background?.color;
      const hasBorder = attributes.border?.color;
      const hasShadow = attributes.shadow?.color;
      const hasText = attributes.innerText?.trim();
      const hasImage = attributes.imageSrc;
      const isSpecial = ["svg", "canvas", "table"].includes(attributes.tagName);

      const occupiesRoot =
        attributes.position?.left === 0 &&
        attributes.position?.top === 0 &&
        attributes.position?.width === rootRect.width &&
        attributes.position?.height === rootRect.height;

      const hasVisual = hasBackground || hasBorder || hasShadow || hasText;
      return (hasVisual && !occupiesRoot) || hasImage || isSpecial;
    });

    const sorted = filtered.sort((a, b) => {
      const zA = a.attributes.zIndex || 0;
      const zB = b.attributes.zIndex || 0;
      if (zA === zB) return a.depth - b.depth;
      return zB - zA;
    });

    // Apply background color to shadowed elements without background
    const finalElements = sorted.map(({ attributes }) => {
      if (attributes.shadow?.color && !attributes.background?.color && backgroundColor) {
        attributes.background = { color: backgroundColor, opacity: undefined };
      }
      return attributes;
    });

    return {
      elements: finalElements,
      backgroundColor,
      screenshotElements: screenshotPaths,
    };
  }, rootRect);

  return result as BatchExtractResult;
}

/**
 * Get ElementHandles for elements that need screenshots.
 * This is the only additional query needed after batch extraction.
 */
export async function getScreenshotElementHandles(
  slideElement: ElementHandle<Element>,
  elementPaths: string[]
): Promise<Map<string, ElementHandle<Element>>> {
  const handles = new Map<string, ElementHandle<Element>>();

  for (const path of elementPaths) {
    try {
      const handle = await slideElement.$(path);
      if (handle) {
        handles.set(path, handle);
      }
    } catch (e) {
      console.error(`Failed to get handle for path: ${path}`, e);
    }
  }

  return handles;
}

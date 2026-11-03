export const MM_VIEW_TYPE = 'mindmap';
export const MD_VIEW_TYPE = 'markdown';

export const FRONT_MATTER_REGEX = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export const frontMatterKey = 'mindmap-plugin';
export const mindmapHoverSource = 'mapdown';


export const basicFrontmatter = [
  "---",
  "",
  `${frontMatterKey}: basic`,
  "",
  "---",
  "",
  "",
].join("\n");

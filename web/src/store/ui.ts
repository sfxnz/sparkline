import { create } from 'zustand';

interface UiStore {
  paletteOpen: boolean;
  helpOpen: boolean;
  /** Someone asked for the getting-started guide (sidebar, Settings, the palette): the overview scrolls to it and
   *  moves focus there once, then clears this. */
  guideWanted: boolean;
  /** The guide was just put away on this page: a line says where it went. Not kept across a reload. */
  guideLeft: 'dismissed' | 'complete' | null;
  setPalette: (open: boolean) => void;
  setHelp: (open: boolean) => void;
}

export const useUi = create<UiStore>()((set) => ({
  paletteOpen: false,
  helpOpen: false,
  guideWanted: false,
  guideLeft: null,
  setPalette: (paletteOpen) => { set({ paletteOpen, helpOpen: false }); },
  setHelp: (helpOpen) => { set({ helpOpen, paletteOpen: false }); },
}));

import { create } from 'zustand';

interface UiStore {
  paletteOpen: boolean;
  helpOpen: boolean;
  setPalette: (open: boolean) => void;
  setHelp: (open: boolean) => void;
}

export const useUi = create<UiStore>()((set) => ({
  paletteOpen: false,
  helpOpen: false,
  setPalette: (paletteOpen) => { set({ paletteOpen, helpOpen: false }); },
  setHelp: (helpOpen) => { set({ helpOpen, paletteOpen: false }); },
}));

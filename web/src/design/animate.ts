// Motion's animation engine, loaded as its own chunk (AnimatedNumber imports it dynamically): the first paint
// never waits for it, and until it arrives numbers change instantly, as under reduced motion.
export { animate } from 'motion/react';

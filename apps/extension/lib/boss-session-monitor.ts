export function observeBossSessionChanges(
  root: Node,
  check: () => void,
): MutationObserver {
  const observer = new MutationObserver(check);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  return observer;
}

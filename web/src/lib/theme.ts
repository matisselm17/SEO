import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const EVT = "app:theme";

function current(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("theme", t);
  } catch {
    /* stockage indisponible */
  }
  window.dispatchEvent(new Event(EVT));
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVT, cb);
      return () => window.removeEventListener(EVT, cb);
    },
    current,
    current,
  );
}

"use client";
import { useEffect } from "react";
export function PwaRegistration() {
  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {
        /* La operación online no depende del service worker. */
      });
    }
  }, []);
  return null;
}

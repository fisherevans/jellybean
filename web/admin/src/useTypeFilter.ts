import { useEffect, useState } from "react";
import type { TypeFilter } from "./api";

// useTypeFilter persists the parent's content-type selection in
// localStorage so it survives reloads and feels consistent across the
// three pages that surface it (Sweep, Triage, Search). Default is "both".

const STORAGE_KEY = "jellybean.admin.typeFilter";

function read(): TypeFilter {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "movies" || v === "series" || v === "both") return v;
    return "both";
}

export function useTypeFilter(): [TypeFilter, (next: TypeFilter) => void] {
    const [value, setValue] = useState<TypeFilter>(() => read());

    useEffect(() => {
        function onStorage(e: StorageEvent) {
            if (e.key === STORAGE_KEY) setValue(read());
        }
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    function update(next: TypeFilter) {
        localStorage.setItem(STORAGE_KEY, next);
        setValue(next);
    }

    return [value, update];
}

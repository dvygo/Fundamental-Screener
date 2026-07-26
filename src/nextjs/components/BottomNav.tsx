"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV } from "@/lib/nav";

// Mobile only — a bottom bar of single-letter buttons (M S C N F) that replaces
// the sidebar below md. Hidden on desktop.
export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="flex shrink-0 items-stretch border-t border-neutral-200 bg-white md:hidden">
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 items-center justify-center border-t-2 py-2.5 text-lg font-semibold",
              active ? "border-neutral-900 text-neutral-900" : "border-transparent text-neutral-400",
            )}
          >
            {item.letter}
          </Link>
        );
      })}
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Markets" },
  { href: "/stock-centric", label: "Stock Centric" },
  { href: "/corporate-actions", label: "Corporate Actions" },
  { href: "/news", label: "News" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-fit shrink-0 border-r border-neutral-200 bg-white p-2">
      <nav className="flex flex-col gap-1">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              buttonVariants({ variant: pathname === item.href ? "default" : "ghost" }),
              "h-auto justify-start whitespace-nowrap px-2.5 py-1.5 text-left text-base font-medium",
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}

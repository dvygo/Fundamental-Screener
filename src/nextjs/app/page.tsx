"use client";

import ScreenSection from "@/components/ScreenSection";
import { SCREENS } from "@/lib/screens";

export default function Home() {
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Markets</h1>
      <div className="flex flex-col gap-6 divide-y divide-neutral-200 [&>section:not(:first-child)]:pt-6">
        {SCREENS.map((screen) => (
          <ScreenSection key={screen.id} screen={screen} />
        ))}
      </div>
    </>
  );
}

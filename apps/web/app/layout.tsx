import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";
import "./agent-detail.css";

export const metadata: Metadata = {
  title: "Death Of The Salesman",
  description: "Sales and fundraising command center",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-density="comfortable">
      <body>{children}</body>
    </html>
  );
}

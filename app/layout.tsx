import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Paystack + Flutterwave checkout starter",
  description:
    "A Next.js starter for taking payments in Nigeria with Paystack or Flutterwave, verified on the server.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

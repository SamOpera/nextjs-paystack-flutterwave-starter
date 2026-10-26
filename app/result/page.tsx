import Link from "next/link"

const COPY = {
  paid: {
    title: "Payment confirmed",
    text: "The provider confirmed this payment on the server, for the full price. The order is paid.",
  },
  pending: {
    title: "Still confirming",
    text: "We couldn't reach the payment provider to confirm this yet. If the payment went through, it will be confirmed automatically in a few minutes. Keep the reference below.",
  },
  failed: {
    title: "Payment not confirmed",
    text: "The provider did not confirm a successful payment for the full price. No order was marked paid. If you were charged, contact support with the reference below.",
  },
} as const

export default async function Result({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; ref?: string }>
}) {
  const { status, ref } = await searchParams
  const kind = status === "paid" || status === "pending" ? status : "failed"
  const copy = COPY[kind]

  return (
    <main className="shell">
      <div className={`card result result--${kind}`}>
        <h1>{copy.title}</h1>
        <p>{copy.text}</p>
        {ref && (
          <p className="ref">
            Reference: <code>{ref}</code>
          </p>
        )}
        <Link href="/" className="btn btn--plain">
          Back to checkout
        </Link>
      </div>
    </main>
  )
}

import { formatNaira, PRODUCTS } from "@/lib/catalog"

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main className="shell">
      <p className="tag">Test mode</p>
      <h1>Checkout</h1>
      <p className="lead">
        Pay with Paystack or Flutterwave. Every payment is confirmed with the provider on the
        server before the order counts as paid.
      </p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <form action="/api/checkout" method="post" className="card">
        <fieldset>
          <legend>Choose a product</legend>
          {PRODUCTS.map((product, index) => (
            <label key={product.id} className="option">
              <input type="radio" name="productId" value={product.id} defaultChecked={index === 0} />
              <span className="option__text">
                <strong>{product.name}</strong>
                <span>{product.description}</span>
              </span>
              <span className="price">{formatNaira(product.priceKobo)}</span>
            </label>
          ))}
        </fieldset>

        <label className="field">
          <span>Email for the receipt</span>
          <input type="email" name="email" required autoComplete="email" placeholder="you@example.com" />
        </label>

        <div className="actions">
          <button type="submit" name="provider" value="paystack" className="btn btn--paystack">
            Pay with Paystack
          </button>
          <button type="submit" name="provider" value="flutterwave" className="btn btn--flutterwave">
            Pay with Flutterwave
          </button>
        </div>
      </form>

      <p className="foot">
        Use the providers&apos; test cards. No real money moves until you switch to live keys.
      </p>
    </main>
  )
}

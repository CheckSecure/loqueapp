/**
 * Creates Loque's Stripe products and prices.
 * Run once: npx tsx scripts/seed-products.ts
 * Safe to re-run — checks for existing products first.
 */
import { getUncachableStripeClient } from '../lib/stripe/stripeClient'

async function createProducts() {
  const stripe = await getUncachableStripeClient()
  console.log('Creating Loque products in Stripe...')

  // ── Professional ───────────────────────────────────────────────
  let proProduct
  const existingPro = await stripe.products.search({ query: "name:'Professional' AND active:'true'" })
  if (existingPro.data.length > 0) {
    proProduct = existingPro.data[0]
    console.log(`Professional already exists: ${proProduct.id}`)
  } else {
    proProduct = await stripe.products.create({
      name: 'Professional',
      description: 'Full access to Loque introductions, messaging, and meeting scheduling.',
      metadata: { tier: 'professional' },
    })
    console.log(`Created Professional: ${proProduct.id}`)

    const proMonthly = await stripe.prices.create({
      product: proProduct.id,
      unit_amount: 4900,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { tier: 'professional', interval: 'month' },
    })
    console.log(`  Monthly $49/mo: ${proMonthly.id}`)

    const proAnnual = await stripe.prices.create({
      product: proProduct.id,
      unit_amount: 47000,
      currency: 'usd',
      recurring: { interval: 'year' },
      metadata: { tier: 'professional', interval: 'year' },
    })
    console.log(`  Annual $470/yr: ${proAnnual.id}`)
  }

  // ── Executive ──────────────────────────────────────────────────
  let execProduct
  const existingExec = await stripe.products.search({ query: "name:'Executive' AND active:'true'" })
  if (existingExec.data.length > 0) {
    execProduct = existingExec.data[0]
    console.log(`Executive already exists: ${execProduct.id}`)
  } else {
    execProduct = await stripe.products.create({
      name: 'Executive',
      description: 'Unlimited introductions, priority matching, and concierge support.',
      metadata: { tier: 'executive' },
    })
    console.log(`Created Executive: ${execProduct.id}`)

    const execMonthly = await stripe.prices.create({
      product: execProduct.id,
      unit_amount: 9900,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { tier: 'executive', interval: 'month' },
    })
    console.log(`  Monthly $99/mo: ${execMonthly.id}`)

    const execAnnual = await stripe.prices.create({
      product: execProduct.id,
      unit_amount: 95000,
      currency: 'usd',
      recurring: { interval: 'year' },
      metadata: { tier: 'executive', interval: 'year' },
    })
    console.log(`  Annual $950/yr: ${execAnnual.id}`)
  }

  // ── Credit Packs ───────────────────────────────────────────────
  const PACKS = [
    { name: 'Credit Pack — 5 Credits', credits: 5, amount: 2500 },
    { name: 'Credit Pack — 10 Credits', credits: 10, amount: 4500 },
    { name: 'Credit Pack — 25 Credits', credits: 25, amount: 9900 },
  ]

  for (const pack of PACKS) {
    const existing = await stripe.products.search({ query: `name:'${pack.name}' AND active:'true'` })
    if (existing.data.length > 0) {
      console.log(`${pack.name} already exists: ${existing.data[0].id}`)
      continue
    }

    const product = await stripe.products.create({
      name: pack.name,
      description: `${pack.credits} introduction credits. Use them to send or accept intro requests.`,
      metadata: { type: 'credit_pack', credits: String(pack.credits) },
    })
    console.log(`Created ${pack.name}: ${product.id}`)

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: pack.amount,
      currency: 'usd',
      metadata: { type: 'credit_pack', credits: String(pack.credits) },
    })
    console.log(`  $${(pack.amount / 100).toFixed(2)} one-time: ${price.id}`)
  }

  console.log('\n✓ All products created. Webhooks will sync them to the database.')
}

createProducts().catch(e => { console.error(e); process.exit(1) })

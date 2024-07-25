import Link from "next/link";

export default function Page() {
  return (
    <>
      <h1>{"Congratulations!"}</h1>
      <p>{"You have successfully self-hosted a Next.js application!"}</p>
      <ul>
        <li>
          <Link href="/ssr-check">{"Check if SSR works"}</Link>
        </li>
      </ul>
    </>
  );
}

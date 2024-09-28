import Link from "next/link";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <hr />
        <p>
          <Link href="https://www.prudkohliad.com">{"Anton's blog"}</Link>
          {" | "}
          <Link href="https://github.com/prutya/next-self-hosted">
            {"Source code"}
          </Link>
        </p>
      </body>
    </html>
  );
}

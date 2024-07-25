import Link from "next/link";

export const revalidate = 0;

async function getData() {
  const randomNumber = Math.random();

  return randomNumber;
}

export default async function Page() {
  const randomNumber = await getData();

  return (
    <>
      <h1>{"SSR Check"}</h1>
      <p>{`The random server-generated number is ${randomNumber}`}</p>
      <ul>
        <li>
          <Link href="/">{"Home"}</Link>
        </li>
      </ul>
    </>
  );
}

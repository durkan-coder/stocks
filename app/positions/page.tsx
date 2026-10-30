import { redirect } from "next/navigation";

// /positions is now the home page (/): the portfolio view at the
// root shows the same open/closed positions, table + charts.
// Keep this route as a redirect so old links and bookmarks land
// on the portfolio instead of a second, drifting copy.
export default function PositionsRedirect() {
  redirect("/");
}

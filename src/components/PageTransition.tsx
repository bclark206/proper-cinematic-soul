import { useLocation } from "react-router-dom";

interface PageTransitionProps {
  children: React.ReactNode;
}

const PageTransition = ({ children }: PageTransitionProps) => {
  const location = useLocation();
  // Keep the authenticated operator shell mounted as staff move between its
  // sections. Marketing pages retain their pathname-keyed entrance behavior.
  const transitionKey = location.pathname.startsWith("/downtown-u/operator/")
    && location.pathname !== "/downtown-u/operator/auth"
    ? "/downtown-u/operator"
    : location.pathname;

  return (
    <div key={transitionKey} className="page-transition">
      {children}
    </div>
  );
};

export default PageTransition;

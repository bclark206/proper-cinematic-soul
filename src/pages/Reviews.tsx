import { useEffect } from "react";

const Reviews = () => {
  useEffect(() => {
    window.location.href = "https://dinereply.app/review/04067e0e-b39c-4705-a143-873eeb55207d";
  }, []);

  return (
    <div className="min-h-screen bg-jet-black flex items-center justify-center">
      <p className="text-cream">Redirecting to reviews...</p>
    </div>
  );
};

export default Reviews;

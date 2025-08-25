import React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const SmsCompliance = () => {

  return (
    <div className="min-h-screen bg-gradient-to-br from-jet-black via-charcoal to-jet-black">
      <div className="container mx-auto px-6 py-12">
        <Link 
          to="/" 
          className="inline-flex items-center text-gold hover:text-gold/80 transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Home
        </Link>
        
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-4xl md:text-5xl font-display font-bold text-pure-white mb-6">
            Join Our SMS List
          </h1>
          <p className="text-xl text-cream mb-8">
            Get exclusive offers, event updates, and culinary news delivered straight to your phone
          </p>
          <p className="text-cream">
            SMS compliance form will be implemented here. This is a minimal version to test routing.
          </p>
        </div>
      </div>
    </div>
  );
};

export default SmsCompliance;